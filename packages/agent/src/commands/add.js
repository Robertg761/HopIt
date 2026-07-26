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
import { scanProjectCandidates } from './scan-projects.js'
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
 * Match what the browser approved against what this command asked for.
 *
 * Deselecting a project in the approval checklist is legitimate user intent, so a
 * SUBSET of the requested set is accepted and the remainder reported as skipped.
 * The two things that abort are an id that was never requested, and an approval
 * that resolved to a different project than the one requested -- the latter being
 * the case that would rm -rf and re-import into the wrong managed workspace.
 *
 * @param {Array<{codebaseId: string, codebaseName: string, source: string}>} candidates
 * @param {Array<{codebaseId: string, requestedCodebaseId?: string|null, sessionId: string, sessionToken: string}>} approvedEntries
 */
export function reconcileApprovedProjects(candidates, approvedEntries) {
  const requested = new Map(candidates.map((candidate) => [candidate.codebaseId, candidate]))
  const connected = []
  for (const entry of approvedEntries) {
    const approvedCodebaseId = assertSafeConnectionCodebaseId(entry.codebaseId)
    const requestedCodebaseId = entry.requestedCodebaseId ?? approvedCodebaseId
    const candidate = requested.get(requestedCodebaseId)
    if (!candidate) {
      throw new Error(
        `hop add aborted: the browser approved "${approvedCodebaseId}", which this command did not request. `
        + 'Nothing was changed. Re-run hop add and approve only the projects it asks for.',
      )
    }
    if (approvedCodebaseId !== requestedCodebaseId) {
      const primaryEnvCodebase = process.env.HOPIT_CODEBASE_ID?.trim()
      if (primaryEnvCodebase && approvedCodebaseId === primaryEnvCodebase) {
        throw new Error(
          `hop add aborted: the browser approved this device's primary project "${approvedCodebaseId}", `
          + `but this command requested a new project "${requestedCodebaseId}". Continuing would import `
          + `${candidate.source} into your primary project and destroy its managed workspace. Nothing was changed. `
          + `Re-run hop add and choose "Create ${requestedCodebaseId}" on the approval page instead of an existing project.`,
        )
      }
      throw new Error(
        `hop add aborted: the browser approved a different project than requested. Requested `
        + `"${requestedCodebaseId}" but the approval returned "${approvedCodebaseId}". Nothing was changed. `
        + `Re-run hop add and choose "Create ${requestedCodebaseId}" on the approval page instead of an existing project.`,
      )
    }
    connected.push({ candidate, entry })
  }

  if (connected.length === 0) {
    throw new Error('hop add aborted: no projects were approved in the browser. Nothing was changed.')
  }
  const connectedIds = new Set(connected.map((item) => item.candidate.codebaseId))
  return {
    connected,
    skipped: candidates.filter((candidate) => !connectedIds.has(candidate.codebaseId)),
  }
}

/**
 * `hop add`: connect any local folder as a new HopIt codebase in one command.
 * With `--all`, every top-level folder in --source becomes a candidate project and
 * the whole set is approved in a single browser round trip.
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

  const scanMode = Boolean(options.all)
  if (scanMode && provided.has('codebase-id')) {
    throw new Error('--codebase-id names a single project. Drop it when using --all.')
  }

  const stateRoot = path.resolve(expandHome(
    options['state-root'] ?? process.env.HOPIT_AGENT_STATE_ROOT ?? defaultAgentStateRoot(),
  ))
  const workspaceRoot = path.resolve(expandHome(
    options._defaultWorkspaceRoot ?? options['workspace-root'] ?? process.env.HOPIT_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
  ))
  const envFilePath = path.resolve(expandHome(
    options['env-path'] ?? path.join(os.homedir(), '.config', 'hopit', 'production.env'),
  ))

  // 1. Derive sane, collision-checked codebase ids. `takenIds` is threaded across
  //    the whole batch so two sibling folders can never derive the same id.
  const takenIds = new Set(await listConnectionCodebaseIds({ 'state-root': stateRoot }))
  const envCodebase = process.env.HOPIT_CODEBASE_ID?.trim()
  if (envCodebase) takenIds.add(envCodebase)

  const candidates = []
  if (scanMode) {
    const scanned = await scanProjectCandidates(source)
    // Every top-level folder is a candidate; signals decide what is offered by
    // DEFAULT. --include-all-folders widens it to folders with no project marker
    // at all, and the browser checklist is where the final selection happens.
    const chosen = options['include-all-folders'] === true ? scanned : scanned.filter((entry) => entry.recommended)
    if (chosen.length === 0) {
      throw new Error(
        `No candidate projects found in ${source}. Pass --include-all-folders to offer every top-level folder, `
        + 'or use --source <folder> without --all to add one directly.',
      )
    }
    for (const entry of chosen) {
      const codebaseId = deriveCodebaseId({ explicitId: null, codebaseName: entry.name, takenIds })
      takenIds.add(codebaseId)
      candidates.push({ codebaseId, codebaseName: entry.name, source: entry.source, signals: entry.signals })
    }
  } else {
    const codebaseName = String(options['codebase-name'] ?? path.basename(source)).trim() || path.basename(source)
    const codebaseId = deriveCodebaseId({
      explicitId: provided.has('codebase-id') ? options['codebase-id'] : null,
      codebaseName,
      takenIds,
    })
    takenIds.add(codebaseId)
    candidates.push({ codebaseId, codebaseName, source, signals: [] })
  }

  // Fail fast on a nested cloud-sync Workspace Root (Dropbox/iCloud/OneDrive/
  // Google Drive) before any directory is created, keyring is written, or
  // browser authorization is requested. EVERY candidate is checked up front so a
  // batch cannot get halfway through and then refuse.
  for (const candidate of candidates) {
    await assertWorkspacePathSafe({ workspace: path.join(workspaceRoot, candidate.codebaseId) })
  }

  if (human) writeLine()
  say(`  ${accent('◆')} ${bold(scanMode ? 'Add projects' : 'Add a project')}  ${muted(source)}`)
  if (scanMode) {
    say(`  ${accent('1/3')}  Requesting ${candidates.length} project${candidates.length === 1 ? '' : 's'}`)
    for (const candidate of candidates) {
      const signals = candidate.signals.length > 0 ? ` ${muted(`[${candidate.signals.join(' ')}]`)}` : ''
      say(`       ${muted('•')} ${candidate.codebaseName} ${muted(`(${candidate.codebaseId})`)}${signals}`)
    }
  } else {
    say(`  ${accent('1/3')}  Requesting codebase ${muted(`${candidates[0].codebaseName} (${candidates[0].codebaseId})`)}`)
  }

  // 2. Prepare the shared device keyring before anything leaves the device. One
  //    keyring covers every project on this device.
  const deviceKeysPath = provided.has('device-keys')
    ? path.resolve(expandHome(options['device-keys']))
    : path.join(stateRoot, 'keys', 'device.json')
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(workspaceRoot, { recursive: true })
  const keyInstallOptions = addRuntimeOptions(options, {
    stateRoot,
    workspaceRoot,
    codebaseId: candidates[0].codebaseId,
    deviceKeysPath,
    envFilePath,
  })
  const keyring = await initializeLocalDeviceKeyring(keyInstallOptions)
  const keyringPath = path.resolve(localDeviceKeyringPath(keyInstallOptions))

  // 3. ONE browser approval covering every requested project. The browser user
  //    decides; each token comes back wrapped to this device's key.
  say(`       ${muted('Waiting for browser approval…')}`)
  const connection = await authorize({
    keyring: keyring.keyring,
    authBaseUrl: options['auth-base-url'] ?? process.env.HOPIT_AUTH_BASE_URL ?? defaultDeviceAuthorizationBaseUrl,
    requestedCodebaseId: candidates[0].codebaseId,
    requestedCodebaseName: candidates[0].codebaseName,
    requestedCodebases: candidates.map((candidate) => ({ id: candidate.codebaseId, name: candidate.codebaseName })),
    commandName: 'hop add',
  })

  // 3a. Reconcile BEFORE any workspace is touched. A mismatch aborts with nothing
  //     changed and there is no override flag; see reconcileApprovedProjects.
  const approvedEntries = Array.isArray(connection.codebases) && connection.codebases.length > 0
    ? connection.codebases
    : [{
        codebaseId: connection.codebaseId,
        requestedCodebaseId: candidates.length === 1 ? candidates[0].codebaseId : null,
        sessionId: connection.sessionId,
        sessionToken: connection.sessionToken,
      }]
  const { connected, skipped } = reconcileApprovedProjects(candidates, approvedEntries)
  say(`  ${success('✓')}  Approved ${muted(connected.map((item) => item.candidate.codebaseId).join(', '))}`)
  if (skipped.length > 0) {
    say(`  ${muted(`Not approved in the browser: ${skipped.map((candidate) => candidate.codebaseId).join(', ')}`)}`)
  }

  const results = []
  for (const [index, item] of connected.entries()) {
    if (connected.length > 1) {
      say(`  ${accent(`${index + 1}/${connected.length}`)}  ${bold(item.candidate.codebaseName)}`)
    }
    results.push(await connectApprovedProject({
      options,
      provided,
      human,
      quiet: connected.length > 1,
      candidate: item.candidate,
      connection: { ...connection, ...item.entry },
      keyring,
      keyringPath,
      stateRoot,
      workspaceRoot,
      envFilePath,
      deviceKeysPath,
    }))
  }

  if (connected.length === 1 && skipped.length === 0) return results[0]

  const batchResult = {
    ok: true,
    action: 'add',
    mode: 'batch',
    source,
    connectedCount: results.length,
    projects: results,
    skipped: skipped.map((candidate) => ({ codebaseId: candidate.codebaseId, source: candidate.source })),
    workspaceRoot,
    agentStateRoot: stateRoot,
    nextSteps: results.flatMap((entry) => entry.nextSteps ?? []),
  }
  reportResult(options, batchResult, (w) => {
    w.line()
    w.line(`  ${w.success('✓')} ${w.bold(`Connected ${results.length} project${results.length === 1 ? '' : 's'}`)}`)
    for (const entry of results) {
      w.line(`     ${w.muted(entry.codebaseId.padEnd(24))} ${entry.workspace}`)
    }
    if (skipped.length > 0) {
      w.line()
      w.line(`  ${w.muted(`Not approved: ${skipped.map((candidate) => candidate.codebaseId).join(', ')}`)}`)
    }
    w.line()
  })
  return batchResult
}

/**
 * Connect ONE approved project: persist its scoped connection, import the folder,
 * attach the workspace, and optionally install its service. This is the original
 * single-project sequence, now run once per project in a batch.
 */
export async function connectApprovedProject({
  options,
  provided,
  human,
  quiet,
  candidate,
  connection,
  keyring,
  keyringPath,
  stateRoot,
  workspaceRoot,
  envFilePath,
  deviceKeysPath,
}) {
  const say = (message) => { if (human) writeLine(message) }
  const { codebaseId, codebaseName, source } = candidate

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
    requestedCodebaseId: connection.requestedCodebaseId ?? codebaseId,
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

  // In a batch, runAdd prints one combined summary instead of N per-project ones.
  if (quiet) {
    say(`       ${success('✓')} ${muted(workspace)}`)
    return result
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
