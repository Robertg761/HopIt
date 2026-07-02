import { spawn } from 'node:child_process'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { mergeLocalProductionEnv, normalizeCloudBackend } from '@/lib/local-production-env'

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
  attachWorkspace: { label: 'Attach workspace', cliCommand: 'workspace', subcommand: 'attach', timeoutMs: 30_000 },
  importGitUrl: { label: 'Import Git URL', cliCommand: 'import-git-url', timeoutMs: 10 * 60 * 1000 },
} as const

type AgentCommand = keyof typeof commandMap
type AgentCommandRequest = {
  command?: unknown
  codebaseId?: unknown
  url?: unknown
  branch?: unknown
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

    const result = await runAgentCli(commandConfig.cliCommand, codebaseId, extraArgs, {
      env: commandEnv,
      prefixArgs: 'subcommand' in commandConfig ? [commandConfig.subcommand] : [],
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
  if (command === 'attachWorkspace') return summarizeAttachWorkspace(result.stdout)
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
  config: { env?: NodeJS.ProcessEnv; prefixArgs?: string[]; timeoutMs?: number } = {},
) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const commandEnv = config.env ?? localCommandEnv()
    const child = spawn(process.execPath, [
      agentCli,
      command,
      ...(config.prefixArgs ?? []),
      ...stateArgsForCodebase(codebaseId, commandEnv),
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
  const requested = env.HOPIT_COMMAND_PROFILE?.trim()
  if (requested === 'production') return 'production'
  if (requested === 'development') return 'development'
  if (env.HOPIT_WORKSPACE_ROOT || env.HOPIT_AGENT_STATE_ROOT || env.HOPIT_WORKSPACE_INDEX) return 'production'
  return 'development'
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
  return [
    ...optionArg('--convex-url', env.HOPIT_CONVEX_URL ?? env.CONVEX_URL),
    ...optionArg('--agent-token', env.HOPIT_AGENT_TOKEN),
  ]
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
  return output.length > 16_000 ? output.slice(-16_000) : output
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
