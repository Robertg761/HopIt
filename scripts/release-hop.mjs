#!/usr/bin/env node

// Build every HopIt target and publish immutable archives/checksums first. The
// mutable channel pointers are uploaded only after immutable artifacts. Full
// releases keep `latest/manifest.json` last, so a failed build never exposes a
// mixed release. Desktop-only releases advance only the Mac updater pointer.

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  VALID_TARGET_KEYS,
  hostTargetKey,
  parseTargets,
  packageTargets,
} from './package-hop.mjs'
import { buildMacDmg, buildMacUpdate } from './package-hop-dmg.mjs'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const artifactsRoot = path.join(repoRoot, 'artifacts')

const BUCKET = 'hopit-releases'
const PUBLIC_BASE_URL = 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'

const CONTENT_TYPES = {
  '.tar.gz': 'application/gzip',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.sha256': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// latest/ is the moving install target, so keep it short-lived; releases/<v>/ is
// immutable content-addressed history and can be cached hard.
const CACHE_LATEST = 'public, max-age=300, must-revalidate'
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const allowUnsigned = argv.includes('--allow-unsigned')
  const desktopOnly = argv.includes('--desktop-only')
  assertReleasePublicationAllowed({
    dryRun,
    allowUnsigned,
    unsignedAcknowledgement: process.env.HOPIT_ACKNOWLEDGE_UNSIGNED_PUBLIC_RELEASE,
  })

  // Default to every target; --target/HOP_PACKAGE_TARGET passthrough is honored.
  const hasExplicitTarget =
    argv.some((arg) => arg === '--target' || arg === '-t' || arg.startsWith('--target=')) ||
    Boolean(process.env.HOP_PACKAGE_TARGET)
  const targets = desktopOnly
    ? parseTargets({ argv: ['--target', 'darwin-arm64,darwin-x64'], env: {} })
    : hasExplicitTarget
    ? parseTargets({ argv, env: process.env })
    : parseTargets({ argv: ['--target', 'all'], env: {} })

  const builtAt = new Date().toISOString()
  const version = releaseVersion(builtAt)
  const gitSha = shortGitSha()

  console.error(`Building ${targets.length} target(s) for release ${version} ...`)
  const built = await packageTargets(targets)
  const hasBothMacTargets = ['darwin-arm64', 'darwin-x64']
    .every((target) => built.some((entry) => entry.target === target))
  const mac = hasBothMacTargets
    ? desktopOnly
      ? await buildMacUpdate({ built, version, builtAt, gitSha })
      : await buildMacDmg({ built, version, builtAt, gitSha })
    : null

  const manifest = buildReleaseManifest({ version, gitSha, builtAt, built, mac })
  const publishChannel = hasCompleteReleaseTargetSet(built.map((result) => result.target))
  const publishDesktopChannel = Boolean(mac?.update) && (publishChannel || desktopOnly)

  const manifestPath = path.join(artifactsRoot, `release-manifest-${version.replace(/[^\w.-]/g, '_')}.json`)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // Assemble the full upload plan before touching the network. The mutable
  // channel pointer is deliberately the final item in this plan.
  const uploads = buildReleaseUploadPlan({ version, built, mac, manifestPath, publishChannel, publishDesktopChannel })

  for (const upload of uploads) {
    uploadObject(upload, dryRun)
  }

  const publicUrls = {}
  for (const result of built) {
    publicUrls[result.target] = {
      archive: `${PUBLIC_BASE_URL}/releases/${version}/${result.packageName}.tar.gz`,
      sha256: `${PUBLIC_BASE_URL}/releases/${version}/${result.packageName}.tar.gz.sha256`,
    }
  }
  if (mac) {
    publicUrls.macos = {
      ...(mac.fileName
        ? {
          dmg: `${PUBLIC_BASE_URL}/releases/${version}/${mac.fileName}`,
          sha256: `${PUBLIC_BASE_URL}/releases/${version}/${mac.fileName}.sha256`,
        }
        : {}),
      update: `${PUBLIC_BASE_URL}/releases/${version}/${mac.update.fileName}`,
      updateSha256: `${PUBLIC_BASE_URL}/releases/${version}/${mac.update.fileName}.sha256`,
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    signed: false,
    publishChannel,
    publishDesktopChannel,
    desktopOnly,
    version,
    gitSha,
    builtAt,
    bucket: BUCKET,
    baseUrl: PUBLIC_BASE_URL,
    manifest: {
      latest: `${PUBLIC_BASE_URL}/latest/manifest.json`,
      desktopLatest: `${PUBLIC_BASE_URL}/latest/desktop-manifest.json`,
      release: `${PUBLIC_BASE_URL}/releases/${version}/manifest.json`,
    },
    targets: built.map((result) => ({
      target: result.target,
      sha256: result.sha256,
      verified: result.verified,
    })),
    publicUrls,
  }, null, 2))
}

function uploadObject(upload, dryRun) {
  const contentType = contentTypeFor(upload.key)
  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    `${BUCKET}/${upload.key}`,
    '--file',
    upload.file,
    '--content-type',
    contentType,
    '--cache-control',
    upload.cacheControl,
    '--remote',
  ]

  if (dryRun) {
    console.error(`[dry-run] npx ${args.join(' ')}`)
    return
  }

  console.error(`Uploading ${BUCKET}/${upload.key} (${contentType}) ...`)
  const result = spawnSync('npx', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (result.status !== 0) {
    throw new Error(
      `Upload failed for ${upload.key} (exit ${result.status}). Aborting before any later channel pointer update.`,
    )
  }
}

export function buildReleaseManifest({ version, gitSha, builtAt, built, mac = null }) {
  const targets = {}
  for (const result of built) {
    const archiveName = `${result.packageName}.tar.gz`
    targets[result.target] = {
      key: `releases/${version}/${archiveName}`,
      checksumKey: `releases/${version}/${archiveName}.sha256`,
      sha256: result.sha256,
      verified: result.verified,
    }
  }
  const manifest = {
    schemaVersion: 2,
    version,
    gitSha,
    builtAt,
    targets,
  }
  if (mac?.update) {
    manifest.downloads = {
      macos: {
        ...(mac.fileName
          ? {
            key: `releases/${version}/${mac.fileName}`,
            checksumKey: `releases/${version}/${mac.fileName}.sha256`,
            sha256: mac.sha256,
            verified: mac.verified,
          }
          : {}),
        signed: false,
        notarized: false,
        update: {
          key: `releases/${version}/${mac.update.fileName}`,
          checksumKey: `releases/${version}/${mac.update.fileName}.sha256`,
          sha256: mac.update.sha256,
          size: mac.update.size,
          verified: mac.update.verified,
          format: 'zip',
        },
      },
    }
  }
  return manifest
}

export function buildReleaseUploadPlan({
  version,
  built,
  mac = null,
  manifestPath,
  publishChannel = hasCompleteReleaseTargetSet(built.map((result) => result.target)),
  publishDesktopChannel = Boolean(mac?.update) && publishChannel,
}) {
  const prefix = `releases/${version}`
  const uploads = []
  for (const result of built) {
    const archiveName = `${result.packageName}.tar.gz`
    uploads.push({
      key: `${prefix}/${archiveName}`,
      file: result.archivePath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
    uploads.push({
      key: `${prefix}/${archiveName}.sha256`,
      file: result.checksumPath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
  }
  if (mac?.fileName) {
    uploads.push({
      key: `${prefix}/${mac.fileName}`,
      file: mac.dmgPath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
    uploads.push({
      key: `${prefix}/${mac.fileName}.sha256`,
      file: mac.checksumPath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
  }
  if (mac?.update) {
    uploads.push({
      key: `${prefix}/${mac.update.fileName}`,
      file: mac.update.archivePath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
    uploads.push({
      key: `${prefix}/${mac.update.fileName}.sha256`,
      file: mac.update.checksumPath,
      cacheControl: CACHE_IMMUTABLE,
      phase: 'immutable',
    })
  }
  uploads.push({
    key: `${prefix}/manifest.json`,
    file: manifestPath,
    cacheControl: CACHE_IMMUTABLE,
    phase: 'immutable-manifest',
  })
  if (publishDesktopChannel) {
    uploads.push({
      key: 'latest/desktop-manifest.json',
      file: manifestPath,
      cacheControl: CACHE_LATEST,
      phase: 'desktop-channel-pointer',
    })
  }
  if (publishChannel) {
    uploads.push({
      key: 'latest/manifest.json',
      file: manifestPath,
      cacheControl: CACHE_LATEST,
      phase: 'channel-pointer',
    })
  }
  return uploads
}

export function assertReleasePublicationAllowed({
  dryRun = false,
  allowUnsigned = false,
  unsignedAcknowledgement = '',
} = {}) {
  if (dryRun) return
  if (allowUnsigned && unsignedAcknowledgement === 'I_ACCEPT_UNSIGNED_PUBLIC_DISTRIBUTION') return
  if (allowUnsigned) throw new Error(
    'Unsigned publication requires HOPIT_ACKNOWLEDGE_UNSIGNED_PUBLIC_RELEASE=' +
    'I_ACCEPT_UNSIGNED_PUBLIC_DISTRIBUTION in addition to --allow-unsigned.',
  )
  throw new Error(
    'Release publication is blocked because HopIt artifacts are not signed or notarized. ' +
    'Use --dry-run to verify the plan. To publish an explicitly approved unsigned release, ' +
    'use --allow-unsigned with the acknowledgement variable documented in docs/personal-production.md.',
  )
}

export function hasCompleteReleaseTargetSet(targets = []) {
  const present = new Set(targets)
  return VALID_TARGET_KEYS.every((target) => present.has(target)) && present.size === VALID_TARGET_KEYS.length
}

function contentTypeFor(key) {
  if (key.endsWith('.tar.gz')) return CONTENT_TYPES['.tar.gz']
  if (key.endsWith('.dmg')) return CONTENT_TYPES['.dmg']
  if (key.endsWith('.zip')) return CONTENT_TYPES['.zip']
  if (key.endsWith('.sha256')) return CONTENT_TYPES['.sha256']
  if (key.endsWith('.json')) return CONTENT_TYPES['.json']
  return 'application/octet-stream'
}

export function releaseVersion(builtAt = new Date().toISOString()) {
  const pkg = JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout)
  const buildId = builtAt.replace(/\D/g, '').slice(0, 17)
  if (buildId.length !== 17) throw new Error(`Unable to derive a release build id from ${builtAt}.`)
  return `${pkg.version}+${shortGitSha()}.${buildId}`
}

function shortGitSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`Unable to resolve git sha: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  await main()
}

export { VALID_TARGET_KEYS, hostTargetKey }
