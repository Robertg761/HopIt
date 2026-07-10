#!/usr/bin/env node

// Build every HopIt target and publish immutable archives/checksums first. The
// single mutable `latest/manifest.json` pointer is uploaded last, so an aborted
// release can leave only unreachable immutable objects — never a mixed channel.

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

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const artifactsRoot = path.join(repoRoot, 'artifacts')

const BUCKET = 'hopit-releases'
const PUBLIC_BASE_URL = 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'

const CONTENT_TYPES = {
  '.tar.gz': 'application/gzip',
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
  assertReleasePublicationAllowed({ dryRun, allowUnsigned })

  // Default to every target; --target/HOP_PACKAGE_TARGET passthrough is honored.
  const hasExplicitTarget =
    argv.some((arg) => arg === '--target' || arg === '-t' || arg.startsWith('--target=')) ||
    Boolean(process.env.HOP_PACKAGE_TARGET)
  const targets = hasExplicitTarget
    ? parseTargets({ argv, env: process.env })
    : parseTargets({ argv: ['--target', 'all'], env: {} })

  const builtAt = new Date().toISOString()
  const version = releaseVersion(builtAt)
  const gitSha = shortGitSha()

  console.error(`Building ${targets.length} target(s) for release ${version} ...`)
  const built = await packageTargets(targets)

  const manifest = buildReleaseManifest({ version, gitSha, builtAt, built })
  const publishChannel = hasCompleteReleaseTargetSet(built.map((result) => result.target))

  const manifestPath = path.join(artifactsRoot, `release-manifest-${version.replace(/[^\w.-]/g, '_')}.json`)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // Assemble the full upload plan before touching the network. The mutable
  // channel pointer is deliberately the final item in this plan.
  const uploads = buildReleaseUploadPlan({ version, built, manifestPath, publishChannel })

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

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    publishChannel,
    version,
    gitSha,
    builtAt,
    bucket: BUCKET,
    baseUrl: PUBLIC_BASE_URL,
    manifest: {
      latest: `${PUBLIC_BASE_URL}/latest/manifest.json`,
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

export function buildReleaseManifest({ version, gitSha, builtAt, built }) {
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
  return {
    schemaVersion: 2,
    version,
    gitSha,
    builtAt,
    targets,
  }
}

export function buildReleaseUploadPlan({
  version,
  built,
  manifestPath,
  publishChannel = hasCompleteReleaseTargetSet(built.map((result) => result.target)),
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
  uploads.push({
    key: `${prefix}/manifest.json`,
    file: manifestPath,
    cacheControl: CACHE_IMMUTABLE,
    phase: 'immutable-manifest',
  })
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

export function assertReleasePublicationAllowed({ dryRun = false, allowUnsigned = false } = {}) {
  if (dryRun && !allowUnsigned) return
  if (allowUnsigned) {
    throw new Error(
      'Unsigned publication is disabled because this command targets HopIt public release storage. ' +
      'Use package:hop for local/private dogfood artifacts instead.',
    )
  }
  throw new Error(
    'Release publication is blocked because HopIt artifacts are not signed or notarized. ' +
    'Use --dry-run to verify the plan; public publication has no unsigned escape hatch.',
  )
}

export function hasCompleteReleaseTargetSet(targets = []) {
  const present = new Set(targets)
  return VALID_TARGET_KEYS.every((target) => present.has(target)) && present.size === VALID_TARGET_KEYS.length
}

function contentTypeFor(key) {
  if (key.endsWith('.tar.gz')) return CONTENT_TYPES['.tar.gz']
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
