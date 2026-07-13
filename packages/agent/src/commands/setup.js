// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { publicDeviceKeyDescriptor, unwrapSymmetricKeyFromDevice } from '@hopit/core/crypto'
import { assertWorkspacePathSafe, isTruthyEnv } from '../paths.js'
import { defaultAgentStateRoot, defaultWorkspaceRoot } from '../options.js'
import { workspaceIndexPath, workspaceIndexSummary } from '../workspace-index.js'
import {
  initializeLocalDeviceKeyring,
  localDeviceKeyringPath,
  registerLocalDeviceKeyringWithCloud,
  writeLocalDeviceKeyring,
} from './keys.js'
import { attachWorkspace } from './hydrate.js'
import { isTransientCloudError, withCloudFetchRetry } from '../cloud-retry.js'
import { serviceStatus, startService } from '../service.js'
import {
  ensureAgentDirectories,
  ensureWorkspaceIndexEntry,
  productionEnvTemplate,
  writeLaunchAgent,
} from './install.js'

const execFileAsync = promisify(execFile)
const defaultDeviceAuthorizationBaseUrl = 'https://hopit.dev'

const color = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  teal: '\u001b[38;5;44m',
  green: '\u001b[38;5;42m',
  amber: '\u001b[38;5;214m',
}

function supportsColor() {
  return Boolean(process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb')
}

function paint(value, ...codes) {
  if (!supportsColor()) return String(value)
  return `${codes.join('')}${value}${color.reset}`
}

function bold(value) {
  return paint(value, color.bold)
}

function muted(value) {
  return paint(value, color.dim)
}

function accent(value) {
  return paint(value, color.teal)
}

function success(value) {
  return paint(value, color.green)
}

function caution(value) {
  return paint(value, color.amber)
}

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

function renderWelcome() {
  writeLine()
  writeLine(`  ${accent('◆')} ${bold('HOPIT')}`)
  writeLine(`    ${muted('Your projects, ready wherever you are.')}`)
  writeLine()
  writeLine(`    ${muted('Let’s prepare this device. It takes about a minute.')}`)
  writeLine()
}

function renderStep(current, total, title, detail) {
  writeLine(`  ${accent(`${current}/${total}`)}  ${bold(title)}`)
  if (detail) writeLine(`       ${muted(detail)}`)
  writeLine()
}

function renderProgress(label, value) {
  writeLine(`  ${success('✓')}  ${label}${value ? `  ${muted(value)}` : ''}`)
}

function renderPending(label, value) {
  writeLine(`  ${caution('○')}  ${label}${value ? `  ${muted(value)}` : ''}`)
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

async function directoryInventory(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return {
      total: entries.length,
      directories: entries.filter((entry) => entry.isDirectory()).length,
      files: entries.filter((entry) => !entry.isDirectory()).length,
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { total: 0, directories: 0, files: 0 }
    }
    throw error
  }
}

function appleScriptString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function openDirectoryPicker(defaultPath) {
  // Test and headless environments can supply the picker result without opening UI.
  if (process.env.HOPIT_SETUP_PICKER_PATH) {
    return path.resolve(expandHome(process.env.HOPIT_SETUP_PICKER_PATH))
  }

  const pickerDefaultPath = existsSync(defaultPath) ? defaultPath : path.dirname(defaultPath)

  if (process.platform === 'darwin') {
    const prompt = appleScriptString('Choose where HopIt should keep your projects')
    const defaultLocation = appleScriptString(pickerDefaultPath)
    const script = [
      `set chosenFolder to choose folder with prompt "${prompt}" default location POSIX file "${defaultLocation}"`,
      'POSIX path of chosenFolder',
    ].join('\n')
    const { stdout } = await execFileAsync('osascript', ['-e', script])
    return path.resolve(stdout.trim())
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$picker = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$picker.Description = 'Choose where HopIt should keep your projects'",
      `$picker.SelectedPath = '${String(pickerDefaultPath).replaceAll("'", "''")}'`,
      'if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath } else { exit 1 }',
    ].join('; ')
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script])
    return path.resolve(stdout.trim())
  }

  const { stdout } = await execFileAsync('zenity', [
    '--file-selection',
    '--directory',
    '--title=Choose where HopIt should keep your projects',
    `--filename=${path.resolve(pickerDefaultPath)}${path.sep}`,
  ])
  return path.resolve(stdout.trim())
}

async function confirmExistingDirectory(reader, directory) {
  const inventory = await directoryInventory(directory)
  if (inventory.total === 0) return true

  writeLine()
  writeLine(`  ${caution('╭─ Existing contents found')}`)
  writeLine(`  ${caution('│')}  ${inventory.total} item${inventory.total === 1 ? '' : 's'} in ${directory}`)
  writeLine(`  ${caution('│')}  ${inventory.directories} folder${inventory.directories === 1 ? '' : 's'}, ${inventory.files} file${inventory.files === 1 ? '' : 's'}`)
  writeLine(`  ${caution('│')}`)
  writeLine(`  ${caution('│')}  Everything already here will be uploaded to HopIt Cloud.`)
  writeLine(`  ${caution('│')}  Local copies are removed only after the cloud safely acknowledges them.`)
  writeLine(`  ${caution('╰─')}`)
  writeLine()
  return promptYesNo(reader, '  Continue with this folder?', false)
}

async function chooseWorkspaceRoot(reader, workspaceRootDefault, options) {
  const openPicker = await promptYesNo(
    reader,
    '  Open your file explorer to choose a projects folder?',
    true,
  )

  if (!openPicker) {
    const answer = await promptValue(
      reader,
      '  Projects folder',
      workspaceRootDefault,
    )
    const candidate = path.resolve(expandHome(answer))
    await assertRootSafe(candidate, options)
    if (!(await confirmExistingDirectory(reader, candidate))) {
      throw new Error('Setup cancelled. No folder was changed.')
    }
    return candidate
  }

  for (;;) {
    let candidate
    try {
      writeLine(`  ${muted('Opening your file explorer…')}`)
      candidate = await openDirectoryPicker(workspaceRootDefault)
    } catch {
      writeLine(`  ${caution('No folder was selected.')} Enter its path instead.`)
      const answer = await promptValue(reader, '  Projects folder', workspaceRootDefault)
      candidate = path.resolve(expandHome(answer))
    }

    try {
      await assertRootSafe(candidate, options)
    } catch (error) {
      writeLine(`  ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (await confirmExistingDirectory(reader, candidate)) return candidate
    writeLine(`  ${muted('Choose a different folder.')}`)
  }
}

function renderCompletion({ workspaceRoot, keyringPath, envFilePath, cloudConnectionReady }) {
  writeLine()
  renderStep(4, 4, 'YOU’RE READY', 'HopIt is connected and your workspace is ready on this device.')
  renderProgress('Projects folder', workspaceRoot)
  renderProgress('Device encryption', keyringPath)
  if (cloudConnectionReady) {
    renderProgress('HopIt Cloud', 'connected')
  } else {
    renderPending('HopIt Cloud', 'not connected')
  }
  writeLine()
  if (cloudConnectionReady) {
    writeLine(`  ${accent('Done')}  You can close this terminal and open your project.`)
  } else {
    writeLine(`  ${accent('Next')}  Run ${bold('hop setup')} when you’re ready to connect HopIt Cloud.`)
    writeLine(`        ${muted(`Configuration: ${envFilePath}`)}`)
  }
  writeLine(`        ${muted('Run hop setup --advanced for operator settings.')}`)
  writeLine(`        ${muted('The hop command is now available. Try: hop status')}`)
  writeLine()
}

export async function authorizeDeviceWithBrowser({
  keyring,
  authBaseUrl,
  openBrowser = true,
  requestedCodebaseId = null,
  requestedCodebaseName = null,
  commandName = 'hop setup',
}) {
  const baseUrl = String(authBaseUrl ?? defaultDeviceAuthorizationBaseUrl).replace(/\/+$/, '')
  // The create call gets bounded retry-with-backoff: a transient network fault or
  // 5xx/429 here should not abort setup before the user even sees a code. A 4xx
  // (auth/validation) still fails fast so a bad request is not hammered.
  const created = await withCloudFetchRetry(async () => {
    const createResponse = await fetch(`${baseUrl}/api/device-authorizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceKey: publicDeviceKeyDescriptor(keyring),
        ...(requestedCodebaseId ? { requestedCodebaseId: String(requestedCodebaseId) } : {}),
        ...(requestedCodebaseName ? { requestedCodebaseName: String(requestedCodebaseName) } : {}),
      }),
    })
    return readJsonResponse(createResponse, 'Could not start device authorization.')
  })
  const verificationUrl = requireResponseText(created.verificationUriComplete, 'verificationUriComplete')
  const deviceCode = requireResponseText(created.deviceCode, 'deviceCode')
  const expiresAt = requireResponseText(created.expiresAt, 'expiresAt')
  const intervalMs = Math.max(1_000, Number(created.intervalSeconds ?? 2) * 1_000)

  writeLine(`  ${accent('Open')}  ${verificationUrl}`)
  writeLine(`  ${muted(`Confirmation code: ${created.userCode}`)}`)
  if (openBrowser && !isTruthyEnv(process.env.HOPIT_SETUP_SKIP_BROWSER)) {
    await openUrl(verificationUrl).catch(() => {
      writeLine(`  ${caution('Browser did not open automatically.')} Use the link above.`)
    })
  }
  writeLine(`  ${muted('Waiting for approval in your browser…')}`)

  let warnedTransientPoll = false
  while (Date.now() < Date.parse(expiresAt)) {
    await delay(intervalMs)
    let polled
    try {
      polled = await pollDeviceAuthorization(baseUrl, deviceCode)
    } catch (error) {
      // A single dropped connection or 5xx/429/non-JSON blip must not invalidate
      // the user's pending code. Treat it as a missed poll and keep waiting until
      // the authorization's own expiry deadline. Only a non-transient failure
      // (4xx auth/validation with a JSON error body) aborts the flow immediately.
      if (isTransientPollError(error)) {
        if (!warnedTransientPoll) {
          warnedTransientPoll = true
          writeLine(`  ${caution('Network hiccup while checking approval.')} ${muted('Still waiting…')}`)
        }
        continue
      }
      throw error
    }
    if (polled.status === 'pending') continue
    if (polled.status !== 'approved') {
      throw new Error(`Device authorization is ${polled.status ?? 'unavailable'}. Run ${commandName} again.`)
    }
    const tokenContext = requireResponseText(polled.tokenContext, 'tokenContext')
    const wrappedSessionToken = recordValue(polled.wrappedSessionToken)
    if (!wrappedSessionToken) throw new Error('Device authorization response did not include an encrypted session token.')
    const sessionToken = unwrapSymmetricKeyFromDevice({
      wrappedKey: wrappedSessionToken,
      recipientPrivateKeyPem: keyring.encryption.privateKeyPem,
      context: tokenContext,
    }).toString('utf8')
    if (!sessionToken.startsWith('hst_')) throw new Error('Device authorization returned an invalid session token.')
    const apiBaseUrl = requireResponseText(polled.apiBaseUrl, 'apiBaseUrl').replace(/\/+$/, '')
    const blobProvider = optionalResponseText(polled.blobProvider)
    return {
      codebaseId: requireResponseText(polled.codebaseId, 'codebaseId'),
      requesterId: requireResponseText(polled.requesterId, 'requesterId'),
      sessionId: requireResponseText(polled.sessionId, 'sessionId'),
      sessionToken,
      apiBaseUrl,
      remotePushUrl: deriveRemotePushUrl(apiBaseUrl),
      ...(blobProvider ? {
        blobProvider,
        blobBroker: polled.blobBroker === true,
        blobPrefix: optionalResponseText(polled.blobPrefix) ?? '',
      } : {}),
      authorizationId: requireResponseText(polled.authorizationId, 'authorizationId'),
    }
  }
  throw new Error(`Device authorization expired. Run ${commandName} again.`)
}

export function deriveRemotePushUrl(apiBaseUrl) {
  const url = new URL(requireResponseText(apiBaseUrl, 'apiBaseUrl'))
  if (url.protocol !== 'https:') {
    throw new Error('Device authorization API URL must use HTTPS before remote push can be enabled.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Device authorization API URL must not contain credentials, query parameters, or a fragment.')
  }
  url.protocol = 'wss:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/events`
  return url.toString()
}

async function openUrl(url) {
  if (process.platform === 'darwin') return execFileAsync('open', [url])
  if (process.platform === 'win32') return execFileAsync('cmd.exe', ['/d', '/s', '/c', 'start', '', url])
  return execFileAsync('xdg-open', [url])
}

async function readJsonResponse(response, fallbackMessage) {
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.ok !== true) {
    const error = new Error(body?.error?.message ?? fallbackMessage)
    // Surface the HTTP status so isTransientCloudError can decide whether a
    // retry is warranted (429/5xx) or the request is a hard 4xx failure.
    error.status = response.status
    throw error
  }
  return body
}

// One poll attempt against the device-authorization endpoint. On any non-success
// response it throws an Error carrying the HTTP status (for transient
// classification). A missing/non-JSON body is flagged `transient` so a proxy
// error page or truncated response counts as a retryable blip rather than a hard
// failure.
async function pollDeviceAuthorization(baseUrl, deviceCode) {
  const response = await fetch(
    `${baseUrl}/api/device-authorizations?device_code=${encodeURIComponent(deviceCode)}`,
    { headers: { Accept: 'application/json' } },
  )
  const body = await response.json().catch(() => null)
  if (body && typeof body === 'object' && !Array.isArray(body) && body.ok === true) {
    return body
  }
  const error = new Error(body?.error?.message ?? 'Could not check device authorization.')
  error.status = response.status
  if (!body || typeof body !== 'object') error.transient = true
  throw error
}

function isTransientPollError(error) {
  return error?.transient === true || isTransientCloudError(error)
}

function requireResponseText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Device authorization response is missing ${label}.`)
  }
  return value.trim()
}

function optionalResponseText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function productionSetupOptions(options, provided, {
  stateRoot,
  workspaceRoot,
  codebaseId,
  envFilePath,
  universalDeviceKey = false,
}) {
  const workspace = path.join(workspaceRoot, codebaseId)
  return {
    ...options,
    profile: 'production',
    'cloud-backend': 'd1',
    'state-root': stateRoot,
    'workspace-root': workspaceRoot,
    'workspace-index': provided.has('workspace-index')
      ? options['workspace-index']
      : path.join(stateRoot, 'workspaces.json'),
    'codebase-id': codebaseId,
    'device-keys': provided.has('device-keys')
      ? options['device-keys']
      : options['device-keys'] ?? process.env.HOPIT_DEVICE_KEYS_PATH ?? path.join(
        stateRoot,
        'keys',
        universalDeviceKey ? 'device.json' : `${codebaseId}.device.json`,
      ),
    'env-path': envFilePath,
    cloud: provided.has('cloud') ? options.cloud : path.join(stateRoot, 'cloud', `${codebaseId}.json`),
    workspace,
    journal: provided.has('journal') ? options.journal : path.join(stateRoot, 'journal', `${codebaseId}.ndjson`),
    events: provided.has('events') ? options.events : path.join(stateRoot, 'events', `${codebaseId}.ndjson`),
    pid: provided.has('pid') ? options.pid : path.join(stateRoot, 'run', `${codebaseId}.pid`),
  }
}

export async function writeConnectedEnvFile(envFilePath, installOptions, connection) {
  let content = existsSync(envFilePath)
    ? await fs.readFile(envFilePath, 'utf8')
    : productionEnvTemplate(installOptions)
  const values = {
    HOPIT_PROFILE: 'production',
    HOPIT_CLOUD_BACKEND: 'd1',
    HOPIT_CODEBASE_ID: connection.codebaseId,
    HOPIT_D1_API_TOKEN: '',
    HOPIT_D1_API_BASE_URL: connection.apiBaseUrl,
    HOPIT_AGENT_STATE_ROOT: path.resolve(installOptions['state-root']),
    HOPIT_WORKSPACE_ROOT: path.resolve(installOptions['workspace-root']),
    HOPIT_WORKSPACE_INDEX: path.resolve(installOptions['workspace-index']),
    HOPIT_REQUESTER_ID: connection.requesterId,
    HOPIT_SESSION_ID: connection.sessionId,
    HOPIT_DEVICE_NAME: installOptions['device-name'] ?? os.hostname() ?? 'local-device',
    HOPIT_AGENT_SESSION_TOKEN: connection.sessionToken,
    HOPIT_DEVICE_KEYS_PATH: path.resolve(installOptions['device-keys']),
    HOPIT_REMOTE_PULL: '1',
    HOPIT_REMOTE_PUSH: '1',
    HOPIT_REMOTE_PUSH_URL: connection.remotePushUrl,
    ...(connection.blobProvider ? {
      HOPIT_BLOB_PROVIDER: connection.blobProvider,
      HOPIT_BLOB_BROKER: connection.blobBroker ? '1' : '0',
      HOPIT_BLOB_PREFIX: connection.blobPrefix ?? '',
    } : {}),
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${formatEnvValue(value)}`
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`
  }
  await fs.mkdir(path.dirname(envFilePath), { recursive: true, mode: 0o700 })
  await fs.writeFile(envFilePath, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await fs.chmod(envFilePath, 0o600)
}

function formatEnvValue(value) {
  const text = String(value ?? '')
  return /\s|["'#$`\\]/.test(text) ? JSON.stringify(text) : text
}

async function migrateLegacyDeviceKeyring(installOptions, stateRoot, codebaseId) {
  const destination = path.resolve(installOptions['device-keys'])
  if (existsSync(destination)) return false
  const legacyPath = path.join(stateRoot, 'keys', `${codebaseId}.device.json`)
  if (!existsSync(legacyPath) || path.resolve(legacyPath) === destination) return false
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await fs.copyFile(legacyPath, destination)
  if (process.platform !== 'win32') await fs.chmod(destination, 0o600)
  return true
}

async function loadLaunchAgentAndWait(installOptions, launchAgent) {
  const domain = `gui/${process.getuid?.() ?? ''}`
  await execFileAsync('launchctl', ['bootout', domain, launchAgent.label]).catch(() => {})
  try {
    await execFileAsync('launchctl', ['bootstrap', domain, launchAgent.plistPath])
  } catch (error) {
    return {
      ...launchAgent,
      installed: true,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await serviceStatus(installOptions)
    if (status.running && status.ok) {
      return { ...launchAgent, installed: true, loaded: true }
    }
    await delay(100)
  }
  return { ...launchAgent, installed: true, loaded: true, ready: false }
}

function connectedKeyringDocument(keyring, connection) {
  return {
    ...keyring,
    codebaseId: connection.codebaseId,
    updatedAt: new Date().toISOString(),
    device: {
      ...(keyring.device ?? {}),
      deviceId: keyring.device?.deviceId ?? keyring.deviceId,
      deviceName: keyring.device?.deviceName ?? keyring.deviceName,
      sessionId: connection.sessionId,
    },
    credentials: {
      ...(keyring.credentials ?? {}),
      agentSessionToken: connection.sessionToken,
    },
  }
}

export async function runSetup(options) {
  const provided = options._provided ?? new Set()
  const useYes = Boolean(options.yes)
  const forceInteractive =
    Boolean(options.interactive) || isTruthyEnv(process.env.HOPIT_SETUP_ASSUME_TTY)
  const ttyInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY)
  const interactive = !useYes && (forceInteractive || ttyInteractive)
  const connectRequested = provided.has('connect')
    ? Boolean(options.connect)
    : interactive && !options.advanced

  if (!useYes && !interactive) {
    throw new Error(
      'hop setup needs an interactive terminal. Re-run with --yes to accept defaults, or pass explicit flags (for example --workspace-root, --codebase-id, --env-path, --no-launch-agent).',
    )
  }
  if (connectRequested && provided.has('write-env') && !options['write-env']) {
    throw new Error('Connected setup needs its secure environment file. Remove --no-write-env or use --no-connect.')
  }

  const reader = interactive ? createLineReader() : null

  try {
    if (interactive) {
      renderWelcome()
      renderStep(1, 4, 'CHOOSE YOUR PROJECTS FOLDER', 'HopIt keeps every managed project together in one place.')
    }

    // 1. Workspace root
    const workspaceRootDefault = path.resolve(
      expandHome(options['workspace-root'] ?? process.env.HOPIT_WORKSPACE_ROOT ?? defaultWorkspaceRoot()),
    )
    let workspaceRoot
    if (provided.has('workspace-root')) {
      workspaceRoot = path.resolve(expandHome(options['workspace-root']))
      await assertRootSafe(workspaceRoot, options)
      if (interactive && !(await confirmExistingDirectory(reader, workspaceRoot))) {
        throw new Error('Setup cancelled. No folder was changed.')
      }
    } else if (interactive) {
      workspaceRoot = await chooseWorkspaceRoot(reader, workspaceRootDefault, options)
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
    } else if (interactive && options.advanced) {
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
    } else if (interactive && options.advanced) {
      writeEnv = await promptYesNo(reader, `Write the production env template to ${envFilePath}?`, true)
    } else {
      writeEnv = true
    }

    // 5. Start-on-login agent (macOS only)
    const isDarwin = process.platform === 'darwin'
    let launchAgentRequested
    if (provided.has('launch-agent')) {
      launchAgentRequested = Boolean(options['launch-agent']) && isDarwin
    } else if (connectRequested && interactive && options.advanced && isDarwin) {
      launchAgentRequested = await promptYesNo(
        reader,
        'Install and load a macOS start-on-login agent?',
        true,
      )
    } else {
      launchAgentRequested = connectRequested && isDarwin
    }

    let installOptions = productionSetupOptions(options, provided, {
      stateRoot,
      workspaceRoot,
      codebaseId,
      envFilePath,
      universalDeviceKey: connectRequested,
    })
    await assertWorkspacePathSafe(installOptions)

    // 6. Prepare local encryption before anything leaves the device.
    if (interactive) {
      writeLine()
      renderStep(2, 4, 'PREPARE THIS DEVICE', 'Securing a device-only encryption key before connecting.')
    }
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
    await fs.mkdir(workspaceRoot, { recursive: true })
    if (connectRequested) {
      await migrateLegacyDeviceKeyring(installOptions, stateRoot, codebaseId)
    }
    let keyring = await initializeLocalDeviceKeyring(installOptions)
    const keyringPath = path.resolve(localDeviceKeyringPath(installOptions))
    if (interactive) {
      renderProgress('Workspace prepared', workspaceRoot)
      renderProgress('Device encryption ready', keyring.created ? 'new key secured' : 'existing key kept')
    }

    // 7. Authorize this device in the browser and let the user choose a codebase.
    let connection = null
    if (interactive) {
      writeLine()
      renderStep(
        3,
        4,
        'CONNECT HOPIT CLOUD',
        connectRequested
          ? 'Approve this device in your browser. Your private key never leaves this device.'
          : 'Skipped for this local-only setup.',
      )
    }
    if (connectRequested) {
      connection = await authorizeDeviceWithBrowser({
        keyring: keyring.keyring,
        authBaseUrl:
          options['auth-base-url'] ?? process.env.HOPIT_AUTH_BASE_URL ?? defaultDeviceAuthorizationBaseUrl,
      })
      codebaseId = connection.codebaseId
      installOptions = {
        ...productionSetupOptions(options, provided, {
          stateRoot,
          workspaceRoot,
          codebaseId,
          envFilePath,
          universalDeviceKey: true,
        }),
        'd1-api-base-url': connection.apiBaseUrl,
        'requester-id': connection.requesterId,
        'session-id': connection.sessionId,
        'session-token': connection.sessionToken,
        'remote-pull': true,
        'remote-push': true,
        'remote-push-url': connection.remotePushUrl,
      }
      keyring = {
        ...keyring,
        keyring: connectedKeyringDocument(keyring.keyring, connection),
      }
      await writeLocalDeviceKeyring(installOptions, keyring.keyring)
      if (interactive) renderProgress('Account approved', codebaseId)
    } else if (interactive) {
      renderPending('HopIt Cloud', 'not connected')
    }

    await assertWorkspacePathSafe(installOptions)
    const workspace = path.resolve(installOptions.workspace)
    const created = await ensureAgentDirectories({ stateRoot, workspaceRoot, workspace })
    let index = await ensureWorkspaceIndexEntry(installOptions, { codebaseId, workspaceRoot })
    const workspaceIndex = path.resolve(workspaceIndexPath(installOptions))

    // Env file
    let envStatus
    if (connection) {
      const envAlreadyExisted = existsSync(envFilePath)
      await writeConnectedEnvFile(envFilePath, installOptions, connection)
      envStatus = envAlreadyExisted ? 'updated' : 'written'
    } else if (!writeEnv) {
      envStatus = 'skipped'
    } else if (existsSync(envFilePath) && !envForceOverwrite) {
      envStatus = 'kept'
    } else {
      await fs.mkdir(path.dirname(envFilePath), { recursive: true })
      await fs.writeFile(envFilePath, productionEnvTemplate(installOptions), 'utf8')
      envStatus = 'written'
    }

    // Register encryption metadata, attach the selected cloud codebase, and start.
    let cloudRegistration = null
    let attachment = null
    let service = null
    if (connection) {
      try {
        cloudRegistration = await registerLocalDeviceKeyringWithCloud(installOptions, keyring.keyring)
        if (cloudRegistration?.registered) {
          keyring.keyring = {
            ...keyring.keyring,
            updatedAt: new Date().toISOString(),
            cloud: {
              ...(keyring.keyring.cloud ?? {}),
              registeredAt: cloudRegistration.registeredAt,
              deviceKey: cloudRegistration.deviceKey,
              userKeyring: cloudRegistration.userKeyring,
              userVaultWrap: cloudRegistration.userVaultWrap,
            },
          }
          await writeLocalDeviceKeyring(installOptions, keyring.keyring)
        }
      } catch (error) {
        cloudRegistration = {
          registered: false,
          reason: 'existing_encryption_key_requires_recovery',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      attachment = await attachWorkspace({ ...installOptions, quiet: true })
      index = await ensureWorkspaceIndexEntry(installOptions, { codebaseId, workspaceRoot })
    }

    let launchAgent = { installed: false }
    if (connection && launchAgentRequested) {
      const written = await writeLaunchAgent(installOptions)
      launchAgent = await loadLaunchAgentAndWait(installOptions, written)
    }
    if (connection) {
      const existingService = await serviceStatus(installOptions)
      service = existingService.running && existingService.ok
        ? { started: false, alreadyRunning: true, status: existingService }
        : { started: true, result: await startService({ ...installOptions, quiet: true }) }
      if (interactive) {
        renderProgress('Workspace attached', workspace)
        renderProgress('Background sync running', launchAgent.installed ? 'starts at login' : 'started')
      }
    }

    const nextSteps = connection ? [] : [
      `Connect this device: hop setup --connect --workspace-root ${JSON.stringify(workspaceRoot)}`,
    ]
    if (launchAgent.installed && !launchAgent.loaded && launchAgent.loadCommand) {
      nextSteps.push(`Load the start-on-login agent: ${launchAgent.loadCommand}`)
    }

    const cloudConnectionReady = Boolean(connection)
    const result = {
      ok: true,
      action: 'setup',
      codebaseId,
      workspaceRoot,
      agentStateRoot: stateRoot,
      workspace,
      workspaceIndex,
      workspaceIndexSummary: workspaceIndexSummary(installOptions, index),
      envFile: { path: envFilePath, status: envStatus },
      deviceSecurity: {
        path: keyringPath,
        status: keyring.created ? 'created' : 'kept',
      },
      launchAgent,
      connection: connection ? {
        status: 'connected',
        authorizationId: connection.authorizationId,
        requesterId: connection.requesterId,
        sessionId: connection.sessionId,
        remotePushUrl: connection.remotePushUrl,
      } : { status: 'not-connected' },
      cloudRegistration,
      attachment,
      service,
      created,
      nextSteps,
    }

    if (interactive) {
      renderCompletion({
        workspaceRoot,
        keyringPath,
        envFilePath,
        cloudConnectionReady,
      })
    }
    if (!interactive || options.json) {
      console.log(JSON.stringify(result, null, 2))
    }
  } finally {
    reader?.close()
  }
}
