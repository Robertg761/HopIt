// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { assertWorkspacePathSafe, isTruthyEnv } from '../paths.js'
import { defaultAgentStateRoot, defaultWorkspaceRoot } from '../options.js'
import { workspaceIndexPath, workspaceIndexSummary } from '../workspace-index.js'
import {
  ensureAgentDirectories,
  ensureWorkspaceIndexEntry,
  productionEnvTemplate,
  writeLaunchAgent,
} from './install.js'

const execFileAsync = promisify(execFile)

function expandHome(value) {
  if (!value || typeof value !== 'string') return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function writeLine(message = '') {
  process.stderr.write(`${message}\n`)
}

// A small event-driven line reader. node:readline/promises `question()` does not
// reliably resolve for repeated prompts over a piped (non-TTY) stdin, so we read
// lines directly and hand them to awaiting prompts one at a time.
function createLineReader() {
  const rl = readline.createInterface({ input: process.stdin })
  const pending = []
  const buffer = []
  let closed = false
  rl.on('line', (line) => {
    if (pending.length) pending.shift()(line)
    else buffer.push(line)
  })
  rl.on('close', () => {
    closed = true
    while (pending.length) pending.shift()(null)
  })
  return {
    next() {
      if (buffer.length) return Promise.resolve(buffer.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => pending.push(resolve))
    },
    close() {
      rl.close()
    },
  }
}

async function promptValue(reader, message, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  process.stderr.write(`${message}${suffix}: `)
  const line = await reader.next()
  const answer = (line ?? '').trim()
  return answer || defaultValue
}

async function promptYesNo(reader, message, defaultYes) {
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]'
  process.stderr.write(`${message}${suffix} `)
  const line = await reader.next()
  const answer = (line ?? '').trim().toLowerCase()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes'
}

async function assertRootSafe(rootPath, options) {
  await assertWorkspacePathSafe({
    workspace: rootPath,
    'allow-unsafe-workspace': options['allow-unsafe-workspace'],
  })
}

export async function runSetup(options) {
  const provided = options._provided ?? new Set()
  const useYes = Boolean(options.yes)
  const forceInteractive =
    Boolean(options.interactive) || isTruthyEnv(process.env.HOPIT_SETUP_ASSUME_TTY)
  const ttyInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY)
  const interactive = !useYes && (forceInteractive || ttyInteractive)

  if (!useYes && !interactive) {
    throw new Error(
      'hop setup needs an interactive terminal. Re-run with --yes to accept defaults, or pass explicit flags (for example --workspace-root, --codebase-id, --env-path, --no-launch-agent).',
    )
  }

  const reader = interactive ? createLineReader() : null

  try {
    if (interactive) {
      writeLine('HopIt setup — configure where HopIt keeps and watches your codebases.')
      writeLine()
    }

    // 1. Workspace root
    const workspaceRootDefault = path.resolve(
      expandHome(options['workspace-root'] ?? process.env.HOPIT_WORKSPACE_ROOT ?? defaultWorkspaceRoot()),
    )
    let workspaceRoot
    if (provided.has('workspace-root')) {
      workspaceRoot = path.resolve(expandHome(options['workspace-root']))
      await assertRootSafe(workspaceRoot, options)
    } else if (interactive) {
      for (;;) {
        const answer = await promptValue(
          reader,
          'Where should HopIt keep and watch your codebases?',
          workspaceRootDefault,
        )
        const candidate = path.resolve(expandHome(answer))
        try {
          await assertRootSafe(candidate, options)
          workspaceRoot = candidate
          break
        } catch (error) {
          writeLine(`  ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else {
      workspaceRoot = workspaceRootDefault
      await assertRootSafe(workspaceRoot, options)
    }

    // 2. Agent state root (only prompted with --advanced)
    const stateRootDefault = path.resolve(
      expandHome(options['state-root'] ?? process.env.HOPIT_AGENT_STATE_ROOT ?? defaultAgentStateRoot()),
    )
    let stateRoot
    if (provided.has('state-root')) {
      stateRoot = path.resolve(expandHome(options['state-root']))
    } else if (interactive && options.advanced) {
      stateRoot = path.resolve(expandHome(await promptValue(reader, 'Agent state root', stateRootDefault)))
    } else {
      stateRoot = stateRootDefault
    }

    // 3. Codebase id
    const codebaseIdDefault = options['codebase-id'] ?? process.env.HOPIT_CODEBASE_ID ?? 'hopit'
    let codebaseId
    if (provided.has('codebase-id')) {
      codebaseId = options['codebase-id']
    } else if (interactive) {
      codebaseId = await promptValue(reader, 'Codebase id', codebaseIdDefault)
    } else {
      codebaseId = codebaseIdDefault
    }
    codebaseId = String(codebaseId).trim()
    if (!codebaseId) {
      throw new Error('Codebase id cannot be empty.')
    }

    // 4. Env file
    const envFilePath = path.resolve(
      expandHome(options['env-path'] ?? path.join(os.homedir(), '.config', 'hopit', 'production.env')),
    )
    const envForceOverwrite = Boolean(options['force-env'])
    let writeEnv
    if (provided.has('write-env')) {
      writeEnv = Boolean(options['write-env'])
    } else if (interactive) {
      writeEnv = await promptYesNo(reader, `Write the production env template to ${envFilePath}?`, true)
    } else {
      writeEnv = true
    }

    // 6. Launch agent (macOS only)
    const isDarwin = process.platform === 'darwin'
    let launchAgentRequested
    if (provided.has('launch-agent')) {
      launchAgentRequested = Boolean(options['launch-agent']) && isDarwin
    } else if (interactive && isDarwin) {
      launchAgentRequested = await promptYesNo(
        reader,
        'Install and load a macOS start-on-login agent?',
        false,
      )
    } else {
      launchAgentRequested = false
    }

    const workspace = path.join(workspaceRoot, codebaseId)
    const installOptions = {
      ...options,
      'workspace-root': workspaceRoot,
      'state-root': stateRoot,
      'codebase-id': codebaseId,
      workspace,
      profile: 'production',
    }

    await assertWorkspacePathSafe(installOptions)

    // 5. Create directories + seed workspace index (idempotent)
    const created = await ensureAgentDirectories({ stateRoot, workspaceRoot, workspace })
    const index = await ensureWorkspaceIndexEntry(installOptions, { codebaseId, workspaceRoot })
    const workspaceIndex = path.resolve(workspaceIndexPath(installOptions))

    // Env file
    let envStatus
    if (!writeEnv) {
      envStatus = 'skipped'
    } else if (existsSync(envFilePath) && !envForceOverwrite) {
      envStatus = 'kept'
    } else {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true })
      await fs.writeFile(envFilePath, productionEnvTemplate(installOptions), 'utf8')
      envStatus = 'written'
    }

    // Launch agent
    let launchAgent = { installed: false }
    if (launchAgentRequested) {
      const written = await writeLaunchAgent(installOptions)
      let loaded = false
      try {
        await execFileAsync('launchctl', [
          'bootstrap',
          `gui/${process.getuid?.() ?? ''}`,
          written.plistPath,
        ])
        loaded = true
      } catch {
        loaded = false
      }
      launchAgent = { installed: true, loaded, ...written }
    }

    const nextSteps = [
      envStatus === 'written'
        ? `Fill in credential values (D1/R2/session token) in ${envFilePath}`
        : `Confirm credential values (D1/R2/session token) in ${envFilePath}`,
      'Initialize the local device keyring: hop keys init-device',
      'Register this device/session: hop session register',
      `Attach the codebase workspace: hop workspace attach --codebase-id ${codebaseId}`,
      'Start the local agent service: hop service start',
    ]
    if (launchAgent.installed && !launchAgent.loaded && launchAgent.loadCommand) {
      nextSteps.push(`Load the start-on-login agent: ${launchAgent.loadCommand}`)
    }

    if (interactive) {
      writeLine()
      writeLine('Setup complete. Next steps:')
      for (const step of nextSteps) writeLine(`  - ${step}`)
      writeLine()
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          action: 'setup',
          codebaseId,
          workspaceRoot,
          agentStateRoot: stateRoot,
          workspace,
          workspaceIndex,
          workspaceIndexSummary: workspaceIndexSummary(installOptions, index),
          envFile: { path: envFilePath, status: envStatus },
          launchAgent,
          created,
          nextSteps,
        },
        null,
        2,
      ),
    )
  } finally {
    reader?.close()
  }
}
