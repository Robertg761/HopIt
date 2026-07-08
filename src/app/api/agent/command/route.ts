import { spawn } from 'node:child_process'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { localCommandProfile, mergeLocalProductionEnv, normalizeCloudBackend } from '@/lib/local-production-env'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const cwd = process.cwd()
const agentCli = path.join(cwd, 'packages/agent/src/cli.js')
const localStateRoot = '.hopit-agent'

const commandMap = {
  sync: { label: 'Sync once', cliCommand: 'sync' },
  refresh: { label: 'Refresh', cliCommand: 'refresh' },
  recover: { label: 'Recover', cliCommand: 'recover' },
  review: { label: 'Open review', cliCommand: 'review' },
  merge: { label: 'Merge', cliCommand: 'merge' },
  setupWorkspace: { label: 'Set up workspace', cliCommand: 'workspace', subcommand: 'attach', timeoutMs: 30_000 },
  attachWorkspace: { label: 'Attach workspace', cliCommand: 'workspace', subcommand: 'attach', timeoutMs: 30_000 },
  openWorkspace: { label: 'Open workspace', cliCommand: 'workspace', subcommand: 'open', timeoutMs: 60_000 },
  hydrateWorkspace: { label: 'Hydrate workspace', cliCommand: 'refresh', timeoutMs: 60_000 },
  hydratePath: { label: 'Hydrate path', cliCommand: 'workspace', subcommand: 'hydrate-path', timeoutMs: 60_000 },
  pruneWorkspace: { label: 'Free local cache', cliCommand: 'workspace', subcommand: 'prune', timeoutMs: 60_000 },
  pinPath: { label: 'Keep path local', cliCommand: 'workspace', subcommand: 'pin', timeoutMs: 30_000 },
  unpinPath: { label: 'Stop keeping path local', cliCommand: 'workspace', subcommand: 'unpin', timeoutMs: 30_000 },
  dehydrateWorkspace: {
    label: 'Dehydrate workspace',
    cliCommand: 'workspace',
    subcommand: 'dehydrate',
    staticArgs: ['--force'],
    timeoutMs: 60_000,
  },
  importGitUrl: { label: 'Import Git URL', cliCommand: 'import-git-url', timeoutMs: 10 * 60 * 1000 },
} as const

type AgentCommand = keyof typeof commandMap
type AgentCommandRequest = {
  command?: unknown
  codebaseId?: unknown
  url?: unknown
  branch?: unknown
  path?: unknown
  recursive?: unknown
  execute?: unknown
  inactiveMs?: unknown
}

let activeCommand: string | null = null

export async function POST(request: Request) {
  let body: AgentCommandRequest
  let command: AgentCommand

  try {
    body = await request.json()
  } catch {
    return commandError('invalid_request', 'Expected a JSON body with a command field.', 400)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.command !== 'string') {
    return commandError('invalid_request', 'Expected a JSON body with a command field.', 400)
  }

  command = body.command as AgentCommand

  const commandConfig = commandMap[command]
  if (!commandConfig) {
    return commandError('unknown_command', 'Command is not allowed for the local prototype.', 400)
  }

  if (process.env.VERCEL) {
    return commandError(
      'local_agent_required',
      'Hosted HopIt cannot run local workspace commands. Run the HopIt agent on your machine to sync this codebase.',
      501,
    )
  }

  return runExclusiveCommand(command, async () => {
    const commandEnv = localCommandEnv()
    let codebaseId: string
    try {
      codebaseId = codebaseIdFromRequest(body, commandEnv)
    } catch (error) {
      return commandError('invalid_codebase_id', error instanceof Error ? error.message : 'Invalid codebase id.', 400)
    }
    const extraArgs = commandArgsFromRequest(command, body)
    if (extraArgs instanceof NextResponse) return extraArgs
    const staticArgs = 'staticArgs' in commandConfig ? [...commandConfig.staticArgs] : []

    const result = await runAgentCli(commandConfig.cliCommand, codebaseId, extraArgs, {
      env: commandEnv,
      prefixArgs: 'subcommand' in commandConfig ? [commandConfig.subcommand] : [],
      staticArgs,
      timeoutMs: 'timeoutMs' in commandConfig ? commandConfig.timeoutMs : undefined,
    })

    return NextResponse.json(
      {
        ok: result.exitCode === 0,
        command,
        label: commandConfig.label,
        summary: summarizeCommandResult(command, result),
        ...result,
      },
      {
        status: result.exitCode === 0 ? 200 : 500,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  })
}

async function runExclusiveCommand(command: AgentCommand, action: () => Promise<NextResponse>) {
  if (activeCommand) {
    return commandError(
      'command_in_progress',
      `Another local agent action is still running: ${activeCommand}.`,
      409,
    )
  }

  activeCommand = command
  try {
    return await action()
  } finally {
    activeCommand = null
  }
}

function summarizeCommandResult(
  command: keyof typeof commandMap,
  result: { exitCode: number | null; stdout: string; stderr: string },
) {
  if (result.exitCode !== 0) return result.stderr || 'Agent command failed.'

  if (command === 'sync') return summarizeSync(result.stdout)
  if (command === 'refresh') return summarizeRefresh(result.stdout)
  if (command === 'recover') return summarizeRecover(result.stdout)
  if (command === 'review') return 'Opened the active change set for review.'
  if (command === 'merge') return 'Merged the active change set into Main.'
  if (command === 'setupWorkspace') return summarizeSetupWorkspace(result.stdout)
  if (command === 'attachWorkspace') return summarizeAttachWorkspace(result.stdout)
  if (command === 'openWorkspace') return summarizeOpenWorkspace(result.stdout)
  if (command === 'hydrateWorkspace') return summarizeHydrateWorkspace(result.stdout)
  if (command === 'hydratePath') return summarizeHydratePath(result.stdout)
  if (command === 'pruneWorkspace') return summarizePruneWorkspace(result.stdout)
  if (command === 'pinPath') return summarizePinPath(result.stdout, true)
  if (command === 'unpinPath') return summarizePinPath(result.stdout, false)
  if (command === 'dehydrateWorkspace') return summarizeDehydrateWorkspace(result.stdout)
  if (command === 'importGitUrl') return summarizeGitUrlImport(result.stdout)

  return 'Agent command completed.'
}

function summarizeSync(stdout: string) {
  const writes = matchNumber(stdout, /"writes":\s*(\d+)/)
  if (writes === null) return 'Synced local workspace changes.'
  return `Synced ${writes} write${writes === 1 ? '' : 's'} into the active change set.`
}

function summarizeRefresh(stdout: string) {
  const written = matchNumber(stdout, /"written":\s*(\d+)/)
  const deleted = matchNumber(stdout, /"deleted":\s*(\d+)/)
  if (written === null && deleted === null) return 'Refreshed the managed workspace.'
  return `Refreshed workspace: ${written ?? 0} written, ${deleted ?? 0} deleted.`
}

function summarizeRecover(stdout: string) {
  const failed = matchNumber(stdout, /"failed":\s*(\d+)/)
  if (failed && failed > 0) return `Recovery found ${failed} unresolved entr${failed === 1 ? 'y' : 'ies'}.`
  return 'Recovered pending journal entries.'
}

function summarizeAttachWorkspace(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const filesVisible = nestedNumber(parsed, ['files', 'visible'])
  const workspace = nestedString(parsed, ['workspace'])
  if (filesVisible !== null && workspace) {
    return `Attached workspace at ${workspace} with ${filesVisible} visible file${filesVisible === 1 ? '' : 's'}.`
  }
  if (workspace) return `Attached workspace at ${workspace}.`
  return 'Attached the codebase to the Workspace Root.'
}

function summarizeSetupWorkspace(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const filesVisible = nestedNumber(parsed, ['files', 'visible'])
  const workspace = nestedString(parsed, ['workspace'])
  if (filesVisible !== null && workspace) {
    return `Workspace ready at ${workspace} with ${filesVisible} visible file${filesVisible === 1 ? '' : 's'}.`
  }
  if (workspace) return `Workspace ready at ${workspace}.`
  return 'Workspace Root is ready.'
}

function summarizeHydrateWorkspace(stdout: string) {
  const written = matchNumber(stdout, /"written":\s*(\d+)/)
  const deleted = matchNumber(stdout, /"deleted":\s*(\d+)/)
  if (written === null && deleted === null) return 'Hydrated the workspace into a managed local folder.'
  return `Hydrated workspace: ${written ?? 0} written, ${deleted ?? 0} deleted.`
}

function summarizeOpenWorkspace(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const state = nestedString(parsed, ['state'])
  const reason = nestedString(parsed, ['reason'])
  const hydrated = nestedNumber(parsed, ['hydratedPathCount'])
  const planned = nestedNumber(parsed, ['plannedPathCount'])
  if (state === 'skipped') return `Open-time hydration skipped${reason ? ` (${reason})` : ''}.`
  if (hydrated !== null && planned !== null) return `Opened workspace and hydrated ${hydrated} of ${planned} planned file${planned === 1 ? '' : 's'}.`
  return 'Opened the workspace and refreshed the first working set.'
}

function summarizeDehydrateWorkspace(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const removed = nestedNumber(parsed, ['removed'])
  if (removed !== null) {
    return `Returned workspace to metadata-only state and removed ${removed} cached file${removed === 1 ? '' : 's'}.`
  }
  return 'Returned workspace to metadata-only state.'
}

function summarizeHydratePath(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const hydrated = nestedNumber(parsed, ['hydrated'])
  const path = nestedString(parsed, ['path'])
  if (hydrated !== null && path) return `Hydrated ${path} into the local workspace.`
  if (hydrated !== null) return `Hydrated ${hydrated} local file${hydrated === 1 ? '' : 's'}.`
  return 'Hydrated the selected path into the local workspace.'
}

function summarizePruneWorkspace(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  const mode = nestedString(parsed, ['mode'])
  const removed = nestedNumber(parsed, ['removed'])
  const candidates = nestedNumber(parsed, ['candidateCount'])
  if (mode === 'dry-run' && candidates !== null) {
    return `Found ${candidates} clean cached file${candidates === 1 ? '' : 's'} that can be freed.`
  }
  if (removed !== null) return `Freed ${removed} clean cached file${removed === 1 ? '' : 's'} locally.`
  return 'Updated the local cache.'
}

function summarizePinPath(stdout: string, pinned: boolean) {
  const parsed = parseLastJsonObject(stdout)
  const path = nestedString(parsed, ['path'])
  const paths = nestedArrayLength(parsed, ['paths'])
  if (path) return pinned ? `Keeping ${path} local.` : `Stopped keeping ${path} local.`
  if (paths !== null) {
    return pinned
      ? `Keeping ${paths} path${paths === 1 ? '' : 's'} local.`
      : `Stopped keeping ${paths} path${paths === 1 ? '' : 's'} local.`
  }
  return pinned ? 'Keeping the selected path local.' : 'Stopped keeping the selected path local.'
}

function summarizeGitUrlImport(stdout: string) {
  const parsed = parseLastJsonObject(stdout)
  if (!parsed || typeof parsed !== 'object') return 'Imported the remote Git repository.'
  const fileCount = nestedNumber(parsed, ['manifest', 'destination', 'entryCount'])
  const syncSkipped = nestedBoolean(parsed, ['sync', 'skipped'])
  const syncReason = nestedString(parsed, ['sync', 'reason'])
  if (syncSkipped) {
    return `Cloned Git repository into the workspace; cloud sync was skipped${syncReason ? ` (${syncReason})` : ''}.`
  }
  if (fileCount !== null) return `Imported remote Git repository with ${fileCount} workspace entries.`
  return 'Imported the remote Git repository.'
}

function matchNumber(text: string, pattern: RegExp) {
  const match = text.match(pattern)
  return match ? Number(match[1]) : null
}

function runAgentCli(
  command: string,
  codebaseId: string,
  extraArgs: string[] = [],
  config: { env?: NodeJS.ProcessEnv; prefixArgs?: string[]; staticArgs?: string[]; timeoutMs?: number } = {},
) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const commandEnv = config.env ?? localCommandEnv()
    const child = spawn(process.execPath, [
      agentCli,
      command,
      ...(config.prefixArgs ?? []),
      ...stateArgsForCodebase(codebaseId, commandEnv),
      ...(config.staticArgs ?? []),
      ...extraArgs,
    ], {
      cwd,
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Agent command timed out: ${command}`))
    }, config.timeoutMs ?? 15_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = capOutput(stdout + chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capOutput(stderr + chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  }).catch((error) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'Agent command failed.',
  }))
}

function commandArgsFromRequest(command: AgentCommand, body: AgentCommandRequest) {
  if (command === 'hydratePath' || command === 'pinPath' || command === 'unpinPath') {
    return pathCommandArgs(body, { allowAll: false })
  }
  if (command === 'pruneWorkspace') {
    return pathCommandArgs(body, { allowAll: true, defaultPath: 'all', execute: body.execute === true })
  }
  if (command !== 'importGitUrl') return []

  if (typeof body.url !== 'string' || body.url.trim().length === 0) {
    return commandError('invalid_git_url', 'Expected a non-empty Git URL.', 400)
  }

  const url = body.url.trim()
  if (!isRemoteGitUrl(url)) {
    return commandError('invalid_git_url', 'Expected an HTTPS, SSH, or git@host:owner/repo Git URL.', 400)
  }

  const args = ['--url', url, '--skip-service-control']
  if (typeof body.branch === 'string' && body.branch.trim().length > 0) {
    const branch = body.branch.trim()
    if (branch.startsWith('-') || /[\0\r\n]/.test(branch)) {
      return commandError('invalid_git_branch', 'Git branch contains unsupported characters.', 400)
    }
    args.push('--branch', branch)
  }
  return args
}

function pathCommandArgs(
  body: AgentCommandRequest,
  options: { allowAll: boolean; defaultPath?: string; execute?: boolean },
) {
  const requestedPath = cloudPathFromRequest(body.path, options)
  if (requestedPath instanceof NextResponse) return requestedPath

  const args = ['--path', requestedPath]
  if (body.recursive === true) args.push('--recursive')
  if (options.execute) args.push('--execute')
  if (body.inactiveMs !== undefined) {
    const inactiveMs = numericRequestValue(body.inactiveMs, 'inactiveMs')
    if (inactiveMs instanceof NextResponse) return inactiveMs
    args.push('--inactive-ms', String(inactiveMs))
  }
  return args
}

function cloudPathFromRequest(
  value: unknown,
  options: { allowAll: boolean; defaultPath?: string },
) {
  const raw = typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : options.defaultPath
  if (!raw) return commandError('invalid_path', 'Expected a non-empty cloud path.', 400)
  if (raw === 'all') {
    if (options.allowAll) return raw
    return commandError('invalid_path', 'This command requires a file or folder path.', 400)
  }
  if (raw.startsWith('-') || /[\0\r\n]/.test(raw) || path.isAbsolute(raw)) {
    return commandError('invalid_path', 'Cloud path contains unsupported characters.', 400)
  }

  const normalized = path.posix.normalize(raw).replace(/\/+$/g, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return commandError('invalid_path', 'Cloud path must stay inside the workspace.', 400)
  }
  return normalized
}

function numericRequestValue(value: unknown, label: string) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0) {
    return commandError('invalid_number', `${label} must be a non-negative integer.`, 400)
  }
  return parsed
}

function codebaseIdFromRequest(body: AgentCommandRequest, env: NodeJS.ProcessEnv) {
  const requested = typeof body.codebaseId === 'string' ? body.codebaseId.trim() : ''
  const fallback = env.HOPIT_CODEBASE_ID ?? 'hopit'
  const codebaseId = requested || fallback
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(codebaseId)) {
    throw new Error('Codebase id may only contain lowercase letters, numbers, and dashes.')
  }
  return codebaseId
}

function stateArgsForCodebase(codebaseId: string, env: NodeJS.ProcessEnv) {
  if (commandProfile(env) === 'production') {
    return [
      '--profile',
      'production',
      '--codebase-id',
      codebaseId,
      ...backendArgs(env),
    ]
  }

  return [
    '--cloud',
    path.join(localStateRoot, 'cloud', `${codebaseId}.json`),
    '--workspace-root',
    path.join(localStateRoot, 'workspaces'),
    '--workspace',
    path.join(localStateRoot, 'workspaces', codebaseId),
    '--workspace-index',
    path.join(localStateRoot, 'workspaces.json'),
    '--journal',
    path.join(localStateRoot, 'journal', `${codebaseId}.ndjson`),
    '--events',
    path.join(localStateRoot, 'events', `${codebaseId}.ndjson`),
    '--codebase-id',
    codebaseId,
    ...backendArgs(env),
  ]
}

function commandProfile(env: NodeJS.ProcessEnv) {
  return localCommandProfile(env)
}

function backendArgs(env: NodeJS.ProcessEnv) {
  const backend = normalizeCloudBackend(env.HOPIT_CLOUD_BACKEND)
  if (backend === 'd1') {
    return [
      '--cloud-backend',
      'd1',
      ...optionArg('--d1-account-id', env.HOPIT_D1_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID),
      ...optionArg('--d1-database-id', env.HOPIT_D1_DATABASE_ID),
      ...optionArg('--d1-api-base-url', env.HOPIT_D1_API_BASE_URL),
    ]
  }
  return []
}

function localCommandEnv(): NodeJS.ProcessEnv {
  return mergeLocalProductionEnv(process.env)
}

function isRemoteGitUrl(value: string) {
  if (/^git@[^:\s]+:[^ \t\r\n]+$/.test(value)) return true

  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'ssh:' || parsed.protocol === 'git:'
  } catch {
    return false
  }
}

function parseLastJsonObject(text: string): unknown {
  const start = text.lastIndexOf('\n{')
  const slice = start >= 0 ? text.slice(start + 1) : text
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function nestedNumber(value: unknown, path: string[]) {
  const found = nestedValue(value, path)
  return typeof found === 'number' ? found : null
}

function nestedBoolean(value: unknown, path: string[]) {
  const found = nestedValue(value, path)
  return typeof found === 'boolean' ? found : null
}

function nestedString(value: unknown, path: string[]) {
  const found = nestedValue(value, path)
  return typeof found === 'string' ? found : null
}

function nestedArrayLength(value: unknown, path: string[]) {
  const found = nestedValue(value, path)
  return Array.isArray(found) ? found.length : null
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function optionArg(name: string, value: string | undefined) {
  return value ? [name, value] : []
}

function capOutput(output: string) {
  return output.length > 64_000 ? output.slice(-64_000) : output
}

function commandError(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
