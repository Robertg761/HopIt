// @ts-check
// `hop update`: check the published release channel and, when a newer build
// exists, replace this installed package in place.
//
// Only meaningful for a PACKAGED install (the tarball from `npm run package:hop`,
// which the macOS/Linux installers copy to a runtime directory). Running from a
// source checkout has no package root to replace, so it reports that and stops.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { reportResult } from '../output.js'

const execFileAsync = promisify(execFile)

// Same immutable release host the desktop updater uses. An archive URL is
// rejected unless it stays on this origin over HTTPS, so a tampered manifest
// cannot redirect the download somewhere else.
export const releaseBaseUrl = 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'
const releaseManifestUrl = `${releaseBaseUrl}/latest/manifest.json`

/**
 * Split a release version into a comparable core plus optional build id.
 * `0.0.1+40e3e2f.20260717025950259` -> core [0,0,1], buildId `40e3e2f.2026...`.
 * A packaged install carries only the plain core (`0.0.1`).
 */
export function parseReleaseVersion(value) {
  if (typeof value !== 'string') return null
  const [core, ...rest] = value.trim().split('+')
  const parts = core.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part))) return null
  return { core: parts, buildId: rest.join('+') || null }
}

/**
 * Is `latest` newer than `current`?
 *
 * Core version wins, then build id, then build timestamp. The timestamp fallback
 * is what makes a locally-built package (plain `0.0.1`, no build id, but a recent
 * `createdAt`) correctly read as NEWER than an older published release -- without
 * it, `hop update` would happily overwrite a fresh local build with a stale one.
 */
export function isReleaseNewer(latest, current) {
  if (!latest?.version) return false
  if (latest.version === current?.version) return false
  const latestCore = parseReleaseVersion(latest.version)
  const currentCore = parseReleaseVersion(current?.version)
  if (!latestCore || !currentCore) {
    return newerTimestamp(latest.builtAt, current?.builtAt)
  }
  const width = Math.max(latestCore.core.length, currentCore.core.length)
  for (let i = 0; i < width; i += 1) {
    const left = latestCore.core[i] ?? 0
    const right = currentCore.core[i] ?? 0
    if (left !== right) return left > right
  }
  if (latestCore.buildId && currentCore.buildId) {
    if (latestCore.buildId !== currentCore.buildId) return latestCore.buildId > currentCore.buildId
    return false
  }
  return newerTimestamp(latest.builtAt, current?.builtAt)
}

function newerTimestamp(latestAt, currentAt) {
  const left = Date.parse(latestAt ?? '')
  const right = Date.parse(currentAt ?? '')
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  return left > right
}

/** Reject any download URL that leaves the release host or drops TLS. */
export function assertReleaseAssetUrl(value) {
  const url = new URL(value)
  const expected = new URL(releaseBaseUrl)
  if (url.protocol !== 'https:' || url.origin !== expected.origin) {
    throw new Error('The update archive must stay on the HopIt release host.')
  }
  return url.toString()
}

/**
 * Locate the installed package root by walking up from this module until a
 * `manifest.json` naming this package appears. Returns null in a source checkout.
 */
export async function findPackageRoot(startDir) {
  let current = startDir ?? path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, 'manifest.json')
    const manifest = await readJsonFile(candidate)
    if (manifest?.name === 'hop' && manifest?.target?.key) {
      return { packageRoot: current, manifest }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function readJsonFile(file) {
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Could not read the release manifest (HTTP ${response.status}).`)
  return response.json()
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * `hop update`. With `--check`, report only. Otherwise download, verify, and
 * swap the package directory, then restart the service if one is managing it.
 */
export async function runUpdate(options = {}) {
  const checkOnly = Boolean(options.check)
  const found = await findPackageRoot(options['package-root']
    ? path.resolve(options['package-root'])
    : undefined)

  if (!found) {
    const result = {
      ok: false,
      action: 'update',
      state: 'not-packaged',
      message: 'hop update only works on a packaged install. This looks like a source checkout; '
        + 'use git to update it, or build a package with npm run package:hop.',
    }
    reportResult(options, result, (w) => {
      w.line()
      w.line(`  ${w.muted(result.message)}`)
      w.line()
    })
    return result
  }

  const { packageRoot, manifest } = found
  const targetKey = manifest.target.key
  const current = { version: manifest.version, builtAt: manifest.createdAt ?? null }

  const latest = await fetchJson(releaseManifestUrl)
  const target = latest?.targets?.[targetKey]
  if (!target?.key || !target?.sha256) {
    throw new Error(`The release channel has no ${targetKey} build to install.`)
  }
  const available = isReleaseNewer({ version: latest.version, builtAt: latest.builtAt }, current)

  if (!available || checkOnly) {
    const result = {
      ok: true,
      action: 'update',
      state: available ? 'available' : 'current',
      currentVersion: current.version,
      currentBuiltAt: current.builtAt,
      latestVersion: latest.version,
      latestBuiltAt: latest.builtAt ?? null,
      target: targetKey,
      packageRoot,
    }
    reportResult(options, result, (w) => {
      w.line()
      if (available) {
        w.line(`  ${w.accent('Update available')}  ${w.muted(`${current.version} -> ${latest.version}`)}`)
        w.line(`  ${w.muted('Install it:')} hop update`)
      } else {
        w.line(`  ${w.success('✓')} ${w.bold('Up to date')} ${w.muted(current.version)}`)
      }
      w.line()
    })
    return result
  }

  const archiveUrl = assertReleaseAssetUrl(`${releaseBaseUrl}/${target.key}`)
  // Stage as a SIBLING of the installed package, never in os.tmpdir(). The final
  // swap is an fs.rename, which fails with EXDEV across filesystems -- and /tmp is
  // commonly a tmpfs while the install lives on the root disk. Staging here keeps
  // the rename within one filesystem, the same thing install.sh does.
  const staging = await fs.mkdtemp(path.join(path.dirname(packageRoot), '.hopit-update-'))
  const archivePath = path.join(staging, 'package.tar.gz')

  try {
    const response = await fetch(archiveUrl)
    if (!response.ok || !response.body) {
      throw new Error(`Could not download the update (HTTP ${response.status}).`)
    }
    await pipeline(response.body, createWriteStream(archivePath))

    // Verify BEFORE anything on disk is replaced. A mismatch aborts with the
    // installed package untouched.
    const digest = await sha256File(archivePath)
    if (digest !== target.sha256) {
      throw new Error(`Update checksum mismatch: expected ${target.sha256}, got ${digest}. Nothing was changed.`)
    }

    const extractRoot = path.join(staging, 'extract')
    await fs.mkdir(extractRoot, { recursive: true })
    await execFileAsync('tar', ['xzf', archivePath, '-C', extractRoot])
    const entries = await fs.readdir(extractRoot)
    const extracted = path.join(extractRoot, entries[0] ?? '')
    const extractedManifest = await readJsonFile(path.join(extracted, 'manifest.json'))
    if (!extractedManifest || extractedManifest.target?.key !== targetKey) {
      throw new Error('The downloaded package is not a valid build for this platform. Nothing was changed.')
    }

    // Swap: move the old package aside, move the new one in, and restore the old
    // one if the move fails. Never delete the running package before the
    // replacement is in place.
    const backup = `${packageRoot}.previous-${Date.now()}`
    await fs.rename(packageRoot, backup)
    try {
      await fs.rename(extracted, packageRoot)
    } catch (moveError) {
      await fs.rename(backup, packageRoot).catch(() => {})
      throw moveError
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})

    const service = await restartManagedService()
    const result = {
      ok: true,
      action: 'update',
      state: 'updated',
      previousVersion: current.version,
      version: extractedManifest.version,
      latestVersion: latest.version,
      target: targetKey,
      packageRoot,
      sha256: digest,
      service,
    }
    reportResult(options, result, (w) => {
      w.line()
      w.line(`  ${w.success('✓')} ${w.bold('Updated')} ${w.muted(`${current.version} -> ${latest.version}`)}`)
      w.line(`     ${w.muted('Folder')}  ${packageRoot}`)
      if (service.restarted) w.line(`     ${w.muted('Service')} restarted`)
      else if (service.reason) w.line(`     ${w.muted('Service')} ${service.reason}`)
      w.line()
    })
    return result
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Restart the user-level service so the new build is actually running. Best
 * effort: a failure here leaves the new package installed and is reported, not
 * thrown, because the update itself already succeeded.
 */
async function restartManagedService() {
  if (process.platform === 'darwin') {
    const label = 'com.hopit.agent.hopit'
    try {
      await execFileAsync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${label}`])
      return { restarted: true, manager: 'launchd', label }
    } catch (error) {
      return { restarted: false, manager: 'launchd', label, reason: 'restart it with: launchctl kickstart -k gui/$UID/com.hopit.agent.hopit' , error: errorText(error) }
    }
  }
  if (process.platform === 'linux') {
    const unit = 'hopit-agent.service'
    try {
      await execFileAsync('systemctl', ['--user', 'restart', unit])
      return { restarted: true, manager: 'systemd', unit }
    } catch (error) {
      return { restarted: false, manager: 'systemd', unit, reason: `restart it with: systemctl --user restart ${unit}`, error: errorText(error) }
    }
  }
  return { restarted: false, reason: 'no managed service on this platform' }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
