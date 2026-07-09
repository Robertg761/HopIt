// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createObjectBlobStore, normalizeBlobProvider } from './blob-stores/index.js'
import { entryEncoding, entryKind } from './constants.js'
import { clientEncryptionScopeFromOptions, clientEncryptionScopes, hasPrivatePrivacyZone, isLocalOnlySecretPath, privacyZoneForPath, rawClientEncryptionKey } from '@hopit/core/crypto'
import { encodeBufferForCloud, hashBuffer, hashDirectoryEntry, hashSymlinkTarget, normalizeCloudFileEntry, toCloudPath } from './journal.js'
import { latestEvent, visibleRevisionFromEvent } from './status-state.js'
import { uniqueCloudPaths } from './workspace-index.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { existsSync } from 'node:fs'

export function contentManifestFromCloud(cloud, hydratedPaths = Object.keys(cloud.files ?? {})) {
  const files = {}
  for (const relativePath of uniqueCloudPaths(hydratedPaths)) {
    const file = cloud.files?.[relativePath]
    if (!file) continue
    const entry = normalizeCloudFileEntry(relativePath, file)
    files[relativePath] = {
      kind: entry.kind,
      hash: entry.hash,
      size: entry.size,
      scope: entry.scope ?? scopeForPath(relativePath),
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: Number.isInteger(entry.revision) ? entry.revision : null,
      target: entry.target ?? null,
    }
  }

  return {
    schemaVersion: 1,
    source: 'cloud-visible-graph',
    fileCount: Object.keys(files).length,
    files,
  }
}

export async function contentManifestFromWorkspace(root) {
  const diskFiles = await readWorkspaceFiles(root)
  const files = {}
  for (const relativePath of Object.keys(diskFiles).sort()) {
    const entry = normalizeCloudFileEntry(relativePath, diskFiles[relativePath])
    files[relativePath] = {
      kind: entry.kind,
      hash: entry.hash,
      size: entry.size,
      scope: entry.scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: null,
      target: entry.target ?? null,
    }
  }

  return {
    schemaVersion: 1,
    source: 'workspace-disk',
    fileCount: Object.keys(files).length,
    files,
  }
}

export function contentManifestSummary(manifest) {
  return {
    exists: Boolean(manifest?.files),
    schemaVersion: manifest?.schemaVersion ?? null,
    fileCount: manifest?.fileCount ?? (manifest?.files ? Object.keys(manifest.files).length : 0),
    source: manifest?.source ?? null,
  }
}

export async function workspaceLocalChanges(options, indexedCodebase) {
  if (!existsSync(options.workspace)) {
    return {
      safe: false,
      state: 'missing',
      reason: 'workspace_missing',
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      samplePaths: [],
    }
  }

  const baseline = indexedCodebase?.contentManifest
  if (!baseline?.files) {
    const hasEntries = await workspaceHasIncludedEntries(options.workspace, options)
    if (!hasEntries) {
      return {
        safe: true,
        state: 'clean',
        reason: null,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        samplePaths: [],
      }
    }

    return {
      safe: false,
      state: 'unknown',
      reason: 'workspace_manifest_missing',
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      samplePaths: [],
    }
  }

  const diff = await diffWorkspaceAgainstManifest(options.workspace, baseline, options)
  const dirty = diff.addedCount > 0 || diff.modifiedCount > 0 || diff.deletedCount > 0

  return {
    safe: !dirty,
    state: dirty ? 'dirty' : 'clean',
    reason: dirty ? 'workspace_has_unjournaled_changes' : null,
    addedCount: diff.addedCount,
    modifiedCount: diff.modifiedCount,
    deletedCount: diff.deletedCount,
    samplePaths: diff.samplePaths,
  }
}

export async function workspaceHasIncludedEntries(root, options = {}) {
  let found = false

  async function walk(dir) {
    if (found) return 0
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          found = true
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
      } else {
        found = true
        includedChildren += 1
      }

      if (found) return includedChildren
    }

    return includedChildren
  }

  await walk(root)
  return found
}

export async function diffWorkspaceAgainstManifest(root, baseline, options = {}) {
  const baselineFiles = baseline?.files ?? {}
  const seen = new Set()
  const samplePaths = []
  let addedCount = 0
  let modifiedCount = 0

  function sample(relativePath) {
    if (samplePaths.length < 10) samplePaths.push(relativePath)
  }

  function recordAdded(relativePath) {
    addedCount += 1
    sample(relativePath)
  }

  async function compareEntry(relativePath, actualFactory) {
    const expected = baselineFiles[relativePath]
    if (!expected) {
      recordAdded(relativePath)
      return
    }

    seen.add(relativePath)
    const actual = await actualFactory()
    if (manifestEntryChanged(expected, actual)) {
      modifiedCount += 1
      sample(relativePath)
    }
  }

  async function walk(dir) {
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isSymbolicLink()) {
        await compareEntry(relativePath, () => readWorkspaceSymlinkEntry(root, relativePath, absolutePath))
        includedChildren += 1
        continue
      }

      if (entry.isDirectory()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          await compareEntry(relativePath, () => workspaceDirectoryEntry(relativePath))
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }

      if (!entry.isFile()) continue

      await compareEntry(relativePath, () => readWorkspaceFileEntry(root, relativePath, absolutePath))
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)

  let deletedCount = 0
  for (const relativePath of Object.keys(baselineFiles).sort()) {
    if (seen.has(relativePath)) continue
    deletedCount += 1
    sample(relativePath)
  }

  return {
    addedCount,
    modifiedCount,
    deletedCount,
    samplePaths,
  }
}

export function manifestEntryChanged(expected, actual) {
  return (
    expected.kind !== actual.kind ||
    expected.hash !== actual.hash ||
    expected.size !== actual.size ||
    expected.scope !== actual.scope ||
    (expected.target ?? null) !== (actual.target ?? null)
  )
}

export function diffContentManifests(baseline, disk) {
  const baselineFiles = baseline?.files ?? {}
  const diskFiles = disk?.files ?? {}
  const addedPaths = []
  const modifiedPaths = []
  const deletedPaths = []

  for (const relativePath of Object.keys(diskFiles).sort()) {
    const expected = baselineFiles[relativePath]
    const actual = diskFiles[relativePath]
    if (!expected) {
      addedPaths.push(relativePath)
      continue
    }
    if (
      expected.kind !== actual.kind ||
      expected.hash !== actual.hash ||
      expected.size !== actual.size ||
      expected.scope !== actual.scope ||
      (expected.target ?? null) !== (actual.target ?? null)
    ) {
      modifiedPaths.push(relativePath)
    }
  }

  for (const relativePath of Object.keys(baselineFiles).sort()) {
    if (!diskFiles[relativePath]) deletedPaths.push(relativePath)
  }

  return { addedPaths, modifiedPaths, deletedPaths }
}

export function buildWorkspaceHydration({
  cloudSummary,
  workspaceExists,
  lastWorkspaceReady,
  lastRefreshComplete,
  indexedCodebase,
}) {
  const indexedHydration = indexedCodebase?.hydration ?? null
  const latestMaterializedEvent = latestEvent([lastWorkspaceReady, lastRefreshComplete])
  const lastMaterializedRevision = visibleRevisionFromEvent(latestMaterializedEvent)

  let state = 'not_initialized'
  if (cloudSummary.exists && workspaceExists && indexedHydration?.state === 'metadata-only') {
    state = 'metadata-only'
  } else if (cloudSummary.exists && workspaceExists && indexedHydration?.state === 'partial') {
    state = 'partial'
  } else if (cloudSummary.exists && workspaceExists && latestMaterializedEvent) {
    state = 'materialized'
  } else if (cloudSummary.exists && workspaceExists) {
    state = 'not_materialized'
  } else if (cloudSummary.exists) {
    state = 'not_materialized'
  }

  return {
    state,
    lastMaterializedAt: indexedHydration?.lastMaterializedAt ?? latestMaterializedEvent?.at ?? null,
    lastMaterializedRevision: indexedHydration?.lastMaterializedRevision ?? lastMaterializedRevision,
    selectedStateRevision: cloudSummary.selectedState?.revision ?? null,
    graphRevision: cloudSummary.revision,
    sourceEvent: indexedHydration?.lastEvent ?? latestMaterializedEvent?.event ?? null,
    hydratedPathCount: indexedHydration?.hydratedPathCount ?? indexedHydration?.hydratedPaths?.length ?? null,
  }
}

export function buildRemoteCursor({ cloudSummary, eventsSummary, hydration }) {
  const latestCursorEvent = latestEvent([
    eventsSummary.lastWorkspaceReady,
    eventsSummary.lastRefreshComplete,
    eventsSummary.lastRemoteUpdate,
    eventsSummary.lastAcknowledgement,
  ])
  const graphRevision = cloudSummary.revision
  const materializedRevision = hydration.lastMaterializedRevision
  const behindByRevisions =
    Number.isInteger(graphRevision) && Number.isInteger(materializedRevision)
      ? Math.max(0, graphRevision - materializedRevision)
      : null

  return {
    graphRevision,
    selectedStateId: cloudSummary.selectedState?.id ?? null,
    selectedStateType: cloudSummary.selectedState?.type ?? null,
    selectedStateRevision: cloudSummary.selectedState?.revision ?? null,
    materializedRevision,
    lastMaterializedAt: hydration.lastMaterializedAt,
    lastRemoteUpdateRevision: visibleRevisionFromEvent(eventsSummary.lastRemoteUpdate),
    latestEventRevision: visibleRevisionFromEvent(latestCursorEvent),
    latestEvent: latestCursorEvent?.event ?? null,
    eventCount: eventsSummary.totalEntries,
    behindByRevisions,
  }
}


export function workspaceFilePath(workspace, relativePath) {
  const cloudPath = assertSafeCloudPath(relativePath)
  const root = path.resolve(workspace)
  const absolutePath = path.resolve(root, cloudPath)

  if (!isPathInside(absolutePath, root) && absolutePath !== root) {
    throw new Error(`Refusing workspace path escape: ${relativePath}`)
  }

  return absolutePath
}

export function assertSafeCloudPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Cloud path must be a non-empty string.')
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Cloud path must be relative: ${relativePath}`)
  }

  const normalized = path.posix.normalize(relativePath)
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Cloud path must stay inside the workspace: ${relativePath}`)
  }

  return normalized
}

export function pathsOverlap(first, second) {
  return isPathInside(first, second) || isPathInside(second, first) || path.resolve(first) === path.resolve(second)
}

export function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function readWorkspaceFiles(root, options = {}) {
  const result = {}
  if (!existsSync(root)) return result

  async function walk(dir) {
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isSymbolicLink()) {
        result[relativePath] = await readWorkspaceSymlinkEntry(root, relativePath, absolutePath)
        includedChildren += 1
        continue
      }

      if (entry.isDirectory()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          result[relativePath] = workspaceDirectoryEntry(relativePath)
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }
      if (!entry.isFile()) continue

      result[relativePath] = await readWorkspaceFileEntry(root, relativePath, absolutePath)
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)
  return result
}

export async function sortedDirEntries(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

// Generated/dependency directories the sync scan never uploads. Unlike
// shouldSkipImportPath this deliberately keeps `.git/` — Git internals are
// part of the owner-private mirror contract; node_modules and build output
// are reproducible junk that would flood the cloud graph (a 2026-07-08 scan
// journaled 26k node_modules files before this guard existed).
const generatedWorkspaceDirectories = new Set([
  '.next',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'artifacts',
  'DerivedData',
])

export function shouldSkipWorkspacePath(relativePath, entry, options = {}) {
  const parts = relativePath.split('/')
  const basename = parts.at(-1) ?? relativePath
  if (parts.includes('.hopit')) return true
  if (basename === '.DS_Store') return true
  if (parts.some((part) => generatedWorkspaceDirectories.has(part))) return true
  if (isLocalOnlySecretPath(relativePath) && !shouldSyncLocalOnlySecretPath(relativePath, options)) return true
  return false
}

export function shouldTrackLocalActivityPath(relativePath, entry) {
  return entry.isFile() && isLocalActivityMarkerPath(relativePath)
}

export function isLocalActivityMarkerPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const basename = relativePath.split('/').at(-1) ?? relativePath
  return basename === '.DS_Store'
}

export function shouldSkipLiteralMirrorPath(relativePath, _entry) {
  const parts = relativePath.split('/')
  if (parts.includes('.hopit')) return true
  return false
}

export function shouldSyncLocalOnlySecretPath(relativePath, options = {}) {
  return hasObjectBlobProvider(options) && shouldEncryptClientSide(relativePath, options)
}

export function secretSyncStatus(options = {}) {
  const hasKey = Boolean(rawClientEncryptionKey(options))
  const hasBlobStore = hasObjectBlobProvider(options)
  const scope = clientEncryptionScopeFromOptions(options)
  const enabled = hasKey && hasBlobStore && scope !== clientEncryptionScopes.off
  let reason = null
  if (!hasKey) reason = 'client_encryption_key_missing'
  else if (!hasBlobStore) reason = 'object_blob_provider_missing'
  else if (scope === clientEncryptionScopes.off) reason = 'client_encryption_disabled'

  return {
    enabled,
    reason,
    scope,
  }
}

export function hasObjectBlobProvider(options = {}) {
  return Boolean(normalizeBlobProvider(options['blob-provider'] ?? process.env.HOPIT_BLOB_PROVIDER))
}

export function shouldEncryptClientSide(relativePath, options = {}) {
  if (!rawClientEncryptionKey(options)) return false
  const scope = clientEncryptionScopeFromOptions(options)
  if (scope === clientEncryptionScopes.off) return false
  if (scope === clientEncryptionScopes.all) return true
  if (scope === clientEncryptionScopes.ownerPrivate) return hasPrivatePrivacyZone(relativePath)
  return isLocalOnlySecretPath(relativePath)
}

export async function readWorkspaceFileEntry(_root, relativePath, absolutePath) {
  const buffer = await fs.readFile(absolutePath)
  const encoded = encodeBufferForCloud(buffer)
  return {
    kind: entryKind.file,
    content: encoded.content,
    encoding: encoded.encoding,
    hash: hashBuffer(buffer),
    size: buffer.byteLength,
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

export async function readWorkspaceSymlinkEntry(_root, relativePath, absolutePath) {
  const target = await fs.readlink(absolutePath)
  return {
    kind: entryKind.symlink,
    content: target,
    encoding: entryEncoding.utf8,
    target,
    hash: hashSymlinkTarget(target),
    size: Buffer.byteLength(target),
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

export async function readSingleWorkspaceEntry(root, relativePath) {
  const absolutePath = workspaceFilePath(root, relativePath)
  const stat = await fs.lstat(absolutePath)
  if (stat.isSymbolicLink()) return readWorkspaceSymlinkEntry(root, relativePath, absolutePath)
  if (stat.isDirectory()) return workspaceDirectoryEntry(relativePath)
  if (stat.isFile()) return readWorkspaceFileEntry(root, relativePath, absolutePath)
  throw new Error(`Unsupported workspace entry type: ${relativePath}`)
}

export function workspaceDirectoryEntry(relativePath) {
  return {
    kind: entryKind.directory,
    content: '',
    encoding: entryEncoding.utf8,
    hash: hashDirectoryEntry(relativePath),
    size: 0,
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

export async function readImportableProjectFiles(root) {
  const files = {}
  let skipped = 0

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))

      if (shouldSkipImportPath(relativePath, entry)) {
        skipped += 1
        continue
      }

      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        skipped += 1
        continue
      }

      const content = await readImportableTextFile(absolutePath)
      if (content === null) {
        skipped += 1
        continue
      }

      files[relativePath] = {
        content,
        scope: scopeForPath(relativePath),
        privacyZone: privacyZoneForPath(relativePath),
        revision: 1,
        updatedAt: new Date().toISOString(),
      }
    }
  }

  await walk(root)
  return { files, skipped }
}

export async function readImportableTextFile(filePath) {
  const maxBytes = 512 * 1024
  const stat = await fs.stat(filePath)
  if (stat.size > maxBytes) return null

  const buffer = await fs.readFile(filePath)
  if (buffer.includes(0)) return null

  return buffer.toString('utf8')
}

export function shouldSkipImportPath(relativePath, entry) {
  const parts = relativePath.split('/')
  const basename = parts.at(-1) ?? relativePath
  const ignoredDirectories = new Set([
    '.git',
    '.hopit-agent',
    '.next',
    '.turbo',
    '.vercel',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'artifacts',
    'mounts',
    'DerivedData',
  ])

  if (entry.isDirectory() && ignoredDirectories.has(basename)) return true
  if (parts.some((part) => ignoredDirectories.has(part))) return true
  if (basename === '.DS_Store') return true
  if (basename === 'dev.log' || basename === 'server.log') return true
  if (basename.endsWith('.local')) return true
  if (basename === '.env' || basename.startsWith('.env.')) return true
  if (basename.endsWith('.png') || basename.endsWith('.jpg') || basename.endsWith('.jpeg')) return true
  if (basename.endsWith('.gif') || basename.endsWith('.webp') || basename.endsWith('.ico')) return true
  if (basename.endsWith('.pdf') || basename.endsWith('.zip') || basename.endsWith('.gz')) return true
  if (basename.endsWith('.mp3') || basename.endsWith('.mp4') || basename.endsWith('.mov')) return true
  if (basename.endsWith('.tsbuildinfo')) return true

  return false
}
