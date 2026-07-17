// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
export const RELEASE_BASE_URL = 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'
export const RELEASE_MANIFEST_URL = `${RELEASE_BASE_URL}/latest/desktop-manifest.json`

export function currentAppBundlePath(executablePath) {
  const resolved = path.resolve(executablePath)
  const parts = resolved.split(path.sep)
  const appIndex = parts.findIndex((part) => part.endsWith('.app'))
  if (appIndex < 0) return null
  return `${path.sep}${parts.slice(1, appIndex + 1).join(path.sep)}`
}

export async function readUpdateInfo(resourcesPath, fallbackVersion = '0.0.1+dev') {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(resourcesPath, 'update-info.json'), 'utf8'))
    if (parsed?.schemaVersion !== 1 || typeof parsed.version !== 'string') throw new Error('invalid update info')
    return parsed
  } catch {
    return { schemaVersion: 1, version: fallbackVersion, builtAt: null, gitSha: null, channel: 'latest' }
  }
}

export function parseUpdateManifest(value, baseUrl = RELEASE_BASE_URL) {
  if (!value || value.schemaVersion !== 2) throw new Error('The update manifest has an unsupported schema.')
  const version = String(value.version ?? '')
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('The update manifest has an invalid version.')
  const update = value.downloads?.macos?.update
  const expectedKey = `releases/${version}/HopIt-macOS.zip`
  if (!update || update.key !== expectedKey || update.format !== 'zip') {
    throw new Error('The update manifest does not point to the expected immutable Mac archive.')
  }
  if (!/^[a-f0-9]{64}$/i.test(String(update.sha256 ?? ''))) throw new Error('The update manifest has an invalid checksum.')
  if (update.verified !== true) throw new Error('The published Mac update was not verified by the release build.')
  if (!Number.isSafeInteger(update.size) || update.size <= 0) throw new Error('The update manifest has an invalid archive size.')
  const url = new URL(update.key, `${baseUrl}/`)
  const expectedOrigin = new URL(baseUrl).origin
  if (url.protocol !== 'https:' || url.origin !== expectedOrigin) throw new Error('The update archive must stay on the HopIt release host.')
  return {
    version,
    builtAt: typeof value.builtAt === 'string' ? value.builtAt : null,
    gitSha: typeof value.gitSha === 'string' ? value.gitSha : null,
    url: url.href,
    sha256: update.sha256.toLowerCase(),
    size: update.size,
    signed: value.downloads?.macos?.signed === true,
    notarized: value.downloads?.macos?.notarized === true,
  }
}

export function isReleaseNewer(latest, current) {
  if (!latest?.version || latest.version === current?.version) return false
  const latestCore = parseReleaseVersion(latest.version)
  const currentCore = parseReleaseVersion(current?.version ?? '')
  if (!latestCore || !currentCore) {
    return Boolean(latest.builtAt && current?.builtAt && Date.parse(latest.builtAt) > Date.parse(current.builtAt))
  }
  for (let i = 0; i < 3; i += 1) {
    if (latestCore.core[i] !== currentCore.core[i]) return latestCore.core[i] > currentCore.core[i]
  }
  if (latestCore.buildId && currentCore.buildId) return latestCore.buildId > currentCore.buildId
  return Boolean(latest.builtAt && current?.builtAt && Date.parse(latest.builtAt) > Date.parse(current.builtAt))
}

function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.exec(String(version))
  if (!match) return null
  const buildId = /\.(\d{17})$/.exec(String(version))?.[1] ?? null
  return { core: match.slice(1, 4).map(Number), buildId }
}

export function createDesktopUpdater(options) {
  const listeners = new Set()
  const installedAppPath = currentAppBundlePath(options.executablePath)
  const canSelfUpdate = Boolean(options.isPackaged && options.platform === 'darwin' && installedAppPath && !installedAppPath.startsWith('/Volumes/'))
  let latest = null
  let stagedAppPath = null
  let state = {
    state: canSelfUpdate ? 'idle' : 'unavailable',
    currentVersion: options.current.version,
    latestVersion: null,
    progress: null,
    error: null,
    checkedAt: null,
  }
  const notify = (patch) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
    options.onState?.(state)
    return state
  }

  return {
    getState: () => ({ ...state }),
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async check() {
      if (!canSelfUpdate) return notify({ state: 'unavailable' })
      notify({ state: 'checking', error: null, progress: null })
      try {
        const response = await (options.fetchFn ?? fetch)(options.manifestUrl ?? RELEASE_MANIFEST_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error(`The update service returned ${response.status}.`)
        latest = parseUpdateManifest(await response.json(), options.baseUrl ?? RELEASE_BASE_URL)
        const available = isReleaseNewer(latest, options.current)
        return notify({
          state: available ? 'available' : 'up-to-date',
          latestVersion: latest.version,
          checkedAt: new Date().toISOString(),
        })
      } catch (error) {
        return notify({ state: 'error', error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() })
      }
    },
    async download() {
      if (!latest || state.state !== 'available') throw new Error('No HopIt update is ready to download.')
      const updateRoot = path.join(options.userDataPath, 'updates', latest.version)
      const archivePath = path.join(updateRoot, 'HopIt-macOS.zip')
      const extractRoot = path.join(updateRoot, 'staged')
      await fs.rm(updateRoot, { recursive: true, force: true })
      await fs.mkdir(updateRoot, { recursive: true })
      notify({ state: 'downloading', progress: 0, error: null })
      try {
        await downloadVerifiedArchive({
          url: latest.url,
          destination: archivePath,
          expectedSha256: latest.sha256,
          expectedSize: latest.size,
          fetchFn: options.fetchFn ?? fetch,
          onProgress: (progress) => notify({ state: 'downloading', progress }),
        })
        notify({ state: 'verifying', progress: 1 })
        stagedAppPath = await stageMacUpdate({ archivePath, extractRoot, expectedVersion: latest.version, exec: options.exec ?? execFileAsync })
        return notify({ state: 'ready', progress: 1, error: null })
      } catch (error) {
        stagedAppPath = null
        await fs.rm(updateRoot, { recursive: true, force: true }).catch(() => {})
        return notify({ state: 'error', error: error instanceof Error ? error.message : String(error), progress: null })
      }
    },
    async install() {
      if (state.state !== 'ready' || !stagedAppPath) throw new Error('The HopIt update has not finished downloading.')
      const currentAppPath = currentAppBundlePath(options.executablePath)
      if (!currentAppPath || currentAppPath.startsWith('/Volumes/')) {
        throw new Error('Move HopIt to Applications before using in-app updates.')
      }
      await fs.access(path.dirname(currentAppPath), constants.W_OK).catch(() => {
        throw new Error('HopIt cannot update this installation without permission to replace the app. Move it to your user Applications folder or install the next DMG once.')
      })
      const helperSource = fileURLToPath(new URL('./update-helper.cjs', import.meta.url))
      const helperPath = path.join(path.dirname(stagedAppPath), 'hopit-update-helper.cjs')
      await fs.copyFile(helperSource, helperPath)
      const backupPath = path.join(path.dirname(currentAppPath), `.${path.basename(currentAppPath)}.previous`)
      const child = (options.spawnFn ?? spawn)(options.executablePath, [
        helperPath,
        String(process.pid),
        currentAppPath,
        stagedAppPath,
        backupPath,
      ], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.unref()
      notify({ state: 'installing' })
      options.quit?.()
      return state
    },
  }
}

export async function downloadVerifiedArchive({ url, destination, expectedSha256, expectedSize, fetchFn = fetch, onProgress = () => {} }) {
  const response = await fetchFn(url, { cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error(`The update download returned ${response.status}.`)
  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > expectedSize) {
        callback(new Error('The update download exceeded the published size.'))
        return
      }
      hash.update(chunk)
      onProgress(Math.min(1, received / expectedSize))
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx' }))
  if (received !== expectedSize) throw new Error(`The update size did not match. Expected ${expectedSize} bytes, received ${received}.`)
  if (hash.digest('hex') !== expectedSha256.toLowerCase()) throw new Error('The update checksum did not match. Nothing was installed.')
  return { bytes: received }
}

export async function stageMacUpdate({ archivePath, extractRoot, expectedVersion, exec = execFileAsync }) {
  await fs.rm(extractRoot, { recursive: true, force: true })
  await fs.mkdir(extractRoot, { recursive: true })
  await exec('/usr/bin/ditto', ['-x', '-k', archivePath, extractRoot])
  const appPath = path.join(extractRoot, 'HopIt.app')
  const stat = await fs.stat(appPath).catch(() => null)
  if (!stat?.isDirectory()) throw new Error('The update archive did not contain HopIt.app.')
  const { stdout: bundleId } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])
  if (bundleId.trim() !== 'dev.hopit.desktop') throw new Error('The update archive has the wrong application identity.')
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  const info = await readUpdateInfo(path.join(appPath, 'Contents', 'Resources'))
  if (info.version !== expectedVersion) throw new Error('The staged app version does not match the update manifest.')
  return appPath
}

export async function cleanupPreviousApp(executablePath) {
  const current = currentAppBundlePath(executablePath)
  if (!current || current.startsWith('/Volumes/')) return
  const backup = path.join(path.dirname(current), `.${path.basename(current)}.previous`)
  await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
}
