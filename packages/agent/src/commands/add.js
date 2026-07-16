// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { slugify } from '../io.js'
import { assertWorkspacePathSafe } from '../paths.js'
import { defaultAgentStateRoot, defaultWorkspaceRoot, deriveServicePort } from '../options.js'
import { applyLocalDeviceKeyring, initializeLocalDeviceKeyring, localDeviceKeyringPath } from './keys.js'
import { authorizeDeviceWithBrowser } from './setup.js'
import { importGitProject, importLocalProject } from './import.js'
import { attachWorkspace } from './hydrate.js'
import { serviceStatus, startService } from '../service.js'
import { ensureAgentDirectories, ensureWorkspaceIndexEntry, writeLaunchAgent } from './install.js'
import { workspaceIndexPath, workspaceIndexSummary } from '../workspace-index.js'
import {
  accent,
  bold,
  humanOutputMode,
  muted,
  reportResult,
  success,
  writeLine,
} from '../output.js'
import {
  assertSafeConnectionCodebaseId,
  listConnectionCodebaseIds,
  writeConnectionEntry,
} from '../connections.js'

const execFileAsync = promisify(execFile)
const defaultDeviceAuthorizationBaseUrl = 'https://hopit.dev'

function expandHome(value) {
  if (!value || typeof value !== 'string') return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Derive a sane, collision-free codebase id from an explicit flag or the source
 * folder name. Explicit ids collide loudly; derived ids get a numeric suffix.
 */
export function deriveCodebaseId({ explicitId, codebaseName, takenIds }) {
  const taken = new Set(takenIds)
  if (explicitId !== undefined && explicitId !== null && String(explicitId).trim() !== '') {
    const id = assertSafeConnectionCodebaseId(slugify(String(explicitId)))
    if (taken.has(id)) {
      throw new Error(`Codebase id "${id}" is already connected on this device. Choose another with --codebase-id.`)
    }
    return id
  }

  const base = assertSafeConnectionCodebaseId(slugify(codebaseName))
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`Could not derive an unused codebase id from "${codebaseName}".`)
}

/** Build the production-style runtime options for a connected codebase. */
export function addRuntimeOptions(options, { stateRoot, workspaceRoot, codebaseId, deviceKeysPath, envFilePath }) {
  const provided = options._provided ?? new Set()
  const workspace = path.join(workspaceRoot, codebaseId)
  const pick = (key, fallback) => (provided.has(key) ? options[key] : fallback)
  return {
    ...options,
    profile: 'production',
    'cloud-backend': provided.has('cloud-backend') ? options['cloud-backend'] : (options['cloud-backend'] ?? 'd1'),
    'state-root': stateRoot,
    'workspace-root': workspaceRoot,
    'workspace-index': pick('workspace-index', path.join(stateRoot, 'workspaces.json')),
    'codebase-id': codebaseId,
    'device-keys': pick('device-keys', deviceKeysPath),
    'env-path': envFilePath,
    cloud: pick('cloud', path.join(stateRoot, 'cloud', `${codebaseId}.json`)),
    workspace: pick('workspace', workspace),
    journal: pick('journal', path.join(stateRoot, 'journal', `${codebaseId}.ndjson`)),
    events: pick('events', path.join(stateRoot, 'events', `${codebaseId}.ndjson`)),
    pid: pick('pid', path.join(stateRoot, 'run', `${codebaseId}.pid`)),
    port: pick('port', String(deriveServicePort(codebaseId))),
  }
}

async function loadLaunchAgent(installOptions, launchAgent) {
  if (process.platform !== 'darwin') return { ...launchAgent, installed: true, loaded: false }
  const domain = `gui/${process.getuid?.() ?? ''}`
  await execFileAsync('launchctl', ['bootout', domain, launchAgent.label]).catch(() => {})
  try {
    await execFileAsync('launchctl', ['bootstrap', domain, launchAgent.plistPath])
  } catch (error) {
    return { ...launchAgent, installed: true, loaded: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ...launchAgent, installed: true, loaded: true }
}

/**
 * `hop add`: connect any local folder as a new HopIt codebase in one command.
 *
 * @param {Record<string, any>} options
 * @param {{ authorize?: typeof authorizeDeviceWithBrowser }} [inject]
 */
export async function runAdd(options, inject = {}) {
  const authorize = inject.authorize ?? authorizeDeviceWithBrowser
  const provided = options._provided ?? new Set()
  const human = humanOutputMode(options)
  // Styled phase breadcrumb, shown only in human mode; raw/--json stays clean.
  const say = (message) => { if (human) writeLine(message) }

  if (!options.source) {
    throw new Error('Missing --source <path> for hop add.')
  }
  const source = path.resolve(expandHome(options.source))
  const stat = await fs.stat(source).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Add source is not a directory: ${source}`)
  }

  const stateRoot = path.resolve(expandHome(
    options['state-root'] ?? process.env.HOPIT_AGENT_STATE_ROOT ?? defaultAgentStateRoot(),
  ))
  const workspaceRoot = path.resolve(expandHome(
    options['workspace-root'] ?? process.env.HOPIT_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
  ))
  const envFilePath = path.resolve(expandHome(
    options['env-path'] ?? path.join(os.homedir(), '.config', 'hopit', 'production.env'),
  ))

  // 1. Derive a sane, collision-checked codebase id.
  const codebaseName = String(options['codebase-name'] ?? path.basename(source)).trim() || path.basename(source)
  const takenIds = new Set(await listConnectionCodebaseIds({ 'state-root': stateRoot }))
  const envCodebase = process.env.HOPIT_CODEBASE_ID?.trim()
  if (envCodebase) takenIds.add(envCodebase)
  const requestedCodebaseId = deriveCodebaseId({
    explicitId: provided.has('codebase-id') ? options['codebase-id'] : null,
    codebaseName,
    takenIds,
  })

  if (human) writeLine()
  say(`  ${accent('◆')} ${bold('Add a project')}  ${muted(source)}`)
  say(`  ${accent('1/3')}  Requesting codebase ${muted(`${codebaseName} (${requestedCodebaseId})`)}`)

  // 2. Prepare the shared device keyring before anything leaves the device.
  const deviceKeysPath = provided.has('device-keys')
    ? path.resolve(expandHome(options['device-keys']))
    : path.join(stateRoot, 'keys', 'device.json')
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(workspaceRoot, { recursive: true })
  const keyInstallOptions = addRuntimeOptions(options, {
    stateRoot,
    workspaceRoot,
    codebaseId: requestedCodebaseId,
    deviceKeysPath,
    envFilePath,
  })
  const keyring = await initializeLocalDeviceKeyring(keyInstallOptions)
  const keyringPath = path.resolve(localDeviceKeyringPath(keyInstallOptions))

  // 3. Browser approval for the NEW codebase. The browser user decides; the
  //    token comes back wrapped to this device's key.
  say(`       ${muted('Waiting for browser approval…')}`)
  const connection = await authorize({
    keyring: keyring.keyring,
    authBaseUrl: options['auth-base-url'] ?? process.env.HOPIT_AUTH_BASE_URL ?? defaultDeviceAuthorizationBaseUrl,
    requestedCodebaseId,
    requestedCodebaseName: codebaseName,
    commandName: 'hop add',
  })
  const approvedCodebaseId = assertSafeConnectionCodebaseId(connection.codebaseId)

  // 3a. HARD-FAIL on codebase mismatch. The browser user could approve an
  //     existing project instead of creating the one this command requested.
  //     If we proceeded, we would store a connection for, resolve the workspace
  //     path of, and rm -rf + re-import into the WRONG codebase's managed
  //     workspace. Abort before any connection entry, import/mirror/attach, or
  //     workspace path is touched. There is no override flag.
  if (approvedCodebaseId !== requestedCodebaseId) {
    const primaryEnvCodebase = process.env.HOPIT_CODEBASE_ID?.trim()
    if (primaryEnvCodebase && approvedCodebaseId === primaryEnvCodebase) {
      throw new Error(
        `hop add aborted: the browser approved this device's primary project "${approvedCodebaseId}", `
        + `but this command requested a new project "${requestedCodebaseId}". Continuing would import `
        + `${source} into your primary project and destroy its managed workspace. Nothing was changed. `
        + `Re-run hop add and choose "Create ${requestedCodebaseId}" on the approval page instead of an existing project.`,
      )
    }
    throw new Error(
      `hop add aborted: the browser approved a different project than requested. Requested `
      + `"${requestedCodebaseId}" but the approval returned "${approvedCodebaseId}". Nothing was changed. `
      + `Re-run hop add and choose "Create ${requestedCodebaseId}" on the approval page instead of an existing project.`,
    )
  }

  const codebaseId = approvedCodebaseId
  say(`  ${success('✓')}  Approved ${muted(codebaseId)}`)

  // 4. Persist the per-codebase scoped connection (0600).
  const stored = await writeConnectionEntry({ 'state-root': stateRoot }, {
    codebaseId,
    sessionId: connection.sessionId,
    sessionToken: connection.sessionToken,
    requesterId: connection.requesterId,
    apiBaseUrl: connection.apiBaseUrl,
    remotePushUrl: connection.remotePushUrl,
  })

  // 5. Build runtime options wired to the connection, then apply the local
  //    device keyring so client-side encryption is available for the import.
  let installOptions = addRuntimeOptions(options, {
    stateRoot,
    workspaceRoot,
    codebaseId,
    deviceKeysPath,
    envFilePath,
  })
  installOptions = {
    ...installOptions,
    'd1-api-base-url': provided.has('d1-api-base-url') ? options['d1-api-base-url'] : (connection.apiBaseUrl ?? installOptions['d1-api-base-url']),
    'requester-id': provided.has('requester-id') ? options['requester-id'] : connection.requesterId,
    'session-id': provided.has('session-id') ? options['session-id'] : connection.sessionId,
    'session-token': provided.has('session-token') ? options['session-token'] : connection.sessionToken,
    'owner-id': provided.has('owner-id') ? options['owner-id'] : connection.requesterId,
    'device-name': options['device-name'] ?? keyring.keyring.device?.deviceName ?? os.hostname() ?? 'local-device',
    'remote-pull': true,
    'remote-push': true,
    'remote-push-url': provided.has('remote-push-url') ? options['remote-push-url'] : connection.remotePushUrl,
  }
  installOptions._provided = new Set([...provided, 'requester-id', 'session-id', 'session-token', 'remote-push-url'])
  installOptions = await applyLocalDeviceKeyring(installOptions)

  await assertWorkspacePathSafe(installOptions)
  const workspace = path.resolve(installOptions.workspace)
  const created = await ensureAgentDirectories({ stateRoot, workspaceRoot, workspace })
  await ensureWorkspaceIndexEntry(installOptions, { codebaseId, workspaceRoot })

  // 6. Import the folder through the existing production-safe paths.
  const hasGit = existsSync(path.join(source, '.git'))
  say(`  ${accent('2/3')}  Importing ${hasGit ? 'Git checkout' : 'folder'}…`)
  // The import owns file movement only; the launchd service lifecycle is handled
  // in step 8 (or left to the printed enable command), so keep the mirror path
  // from stopping/restarting a service mid-add. `internal: true` keeps the
  // import/mirror step from printing its own human summary: hop add prints one.
  const importOptions = {
    ...installOptions,
    source,
    'codebase-id': codebaseId,
    'codebase-name': codebaseName,
    'skip-service-control': true,
    internal: true,
  }
  if (hasGit) {
    await importGitProject(importOptions)
  } else {
    await importLocalProject({ ...importOptions, force: true })
  }

  // 7. Attach under the Workspace Root, matching setup/attach.
  const attachment = await attachWorkspace({ ...installOptions, quiet: true }).catch((error) => ({
    ok: false,
    action: 'attach',
    error: error instanceof Error ? error.message : String(error),
  }))
  const index = await ensureWorkspaceIndexEntry(installOptions, { codebaseId, workspaceRoot })

  // 8. Optional per-codebase launchd service (default OFF).
  let launchAgent = { installed: false }
  let service = null
  const serviceRequested = Boolean(options.service) && process.platform === 'darwin'
  if (serviceRequested) {
    const written = await writeLaunchAgent(installOptions)
    launchAgent = await loadLaunchAgent(installOptions, written)
    const existingService = await serviceStatus(installOptions).catch(() => ({ running: false, ok: false }))
    service = existingService.running && existingService.ok
      ? { started: false, alreadyRunning: true }
      : { started: true, result: await startService({ ...installOptions, quiet: true }).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })) }
  }

  const enableServiceCommand = `hop add --source ${JSON.stringify(source)} --codebase-id ${codebaseId} --service`
  const nextSteps = []
  if (!serviceRequested) {
    nextSteps.push(`Run background sync at login: ${enableServiceCommand}`)
  } else if (launchAgent.installed && !launchAgent.loaded && launchAgent.loadCommand) {
    nextSteps.push(`Load the start-on-login agent: ${launchAgent.loadCommand}`)
  }

  const result = {
    ok: true,
    action: 'add',
    codebaseId,
    codebaseName,
    requestedCodebaseId,
    source,
    workspaceRoot,
    agentStateRoot: stateRoot,
    workspace,
    workspaceIndex: path.resolve(workspaceIndexPath(installOptions)),
    workspaceIndexSummary: workspaceIndexSummary(installOptions, index),
    deviceSecurity: { path: keyringPath, status: keyring.created ? 'created' : 'kept' },
    connection: {
      status: 'connected',
      path: stored.path,
      requesterId: connection.requesterId ?? null,
      sessionId: connection.sessionId ?? null,
      remotePushUrl: connection.remotePushUrl ?? null,
    },
    import: { mode: hasGit ? 'import-git' : 'import-local' },
    attachment,
    launchAgent,
    service,
    created,
    nextSteps,
  }

  reportResult(options, result, (w) => {
    w.line()
    w.line(`  ${w.success('✓')} ${w.bold('Connected')} ${w.muted(codebaseId)}`)
    w.line(`     ${w.muted('Folder')}   ${workspace}`)
    w.line(`     ${w.muted('Source')}   ${source}`)
    if (serviceRequested && service?.started) {
      w.line(`     ${w.muted('Sync')}     background service started`)
    }
    w.line()
    if (!serviceRequested) {
      w.line(`  ${w.muted('Next')}  Run background sync at login:`)
      w.line(`        ${w.accent(enableServiceCommand)}`)
    }
  })
  return result
}
