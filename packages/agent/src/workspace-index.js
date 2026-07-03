// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceFileLocalState } from './commands/workspace.js'
import { localCacheSchemaVersion, workspaceIndexVersion, workspaceMode } from './constants.js'
import { readJson, writeJson } from './io.js'
import { normalizeCloudFileEntry } from './journal.js'
import { cloudLocationFromOptions, cloudServiceTypeFromOptions } from './paths.js'
import { workspaceRootFromOptions } from './status-state.js'
import { assertSafeCloudPath, contentManifestFromCloud } from './workspace-manifest.js'
import { existsSync } from 'node:fs'

export async function readWorkspaceIndex(options) {
  const indexPath = workspaceIndexPath(options)
  try {
    return normalizeWorkspaceIndex(await readJson(indexPath), options)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeWorkspaceIndex(options, index) {
  const indexPath = workspaceIndexPath(options)
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await writeJson(indexPath, normalizeWorkspaceIndex(index, options))
}

export async function upsertWorkspaceIndex(options, current) {
  const now = new Date().toISOString()
  const existing = (await readWorkspaceIndex(options)) ?? emptyWorkspaceIndex(options)
  const next = {
    ...existing,
    schemaVersion: workspaceIndexVersion,
    updatedAt: now,
    root: workspaceIndexRoot(options),
    codebases: mergeIndexedCodebases(existing.codebases, current ? storableWorkspaceIndexEntry({
      ...current,
      updatedAt: now,
    }) : null),
  }
  await writeWorkspaceIndex(options, next)
  return next
}

export async function upsertWorkspaceIndexFromCloud(options, cloud, metadata = {}) {
  return upsertWorkspaceIndex(options, workspaceIndexEntryFromCloud(options, cloud, metadata))
}

export async function hydratedPathUnion(options, codebaseId, nextPaths) {
  const index = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(index, codebaseId, options.workspace)
  return uniqueCloudPaths([...(indexedCodebase?.hydratedPaths ?? []), ...nextPaths])
}

export function uniqueCloudPaths(paths) {
  return Array.from(new Set(paths.map((value) => assertSafeCloudPath(value)))).sort()
}

export function selectedCloudPaths(cloud, targetPath, options = {}) {
  const target = targetPath === 'all' ? 'all' : assertSafeCloudPath(String(targetPath ?? ''))
  const cloudPaths = uniqueCloudPaths(Object.keys(cloud.files ?? {}))
  if (target === 'all') return cloudPaths

  const normalizedTarget = target.replace(/\/+$/g, '')
  if (cloud.files?.[normalizedTarget]) return [normalizedTarget]

  const prefixMatches = cloudPaths.filter((relativePath) => cloudPathMatchesPrefix(relativePath, normalizedTarget))
  if (prefixMatches.length === 0) {
    throw new Error(`No visible cloud file matches: ${normalizedTarget}`)
  }
  if (!options.recursive) {
    throw new Error(`Path is a folder prefix with ${prefixMatches.length} visible file${prefixMatches.length === 1 ? '' : 's'}: ${normalizedTarget}. Pass --recursive to include it.`)
  }

  return prefixMatches
}

export function cloudPathMatchesPrefix(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
}

export function parseNonNegativeIntegerOption(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`)
  }
  return parsed
}

export function localCachePatchForPaths(cloud, paths, detail = {}) {
  const now = detail.now ?? new Date().toISOString()
  const files = {}
  for (const relativePath of uniqueCloudPaths(paths)) {
    const cloudEntry = cloud.files?.[relativePath] ? normalizeCloudFileEntry(relativePath, cloud.files[relativePath]) : null
    files[relativePath] = compactObject({
      state: detail.state,
      pinned: detail.pinned,
      lastHydratedAt: detail.lastHydratedAt,
      lastEditedAt: detail.lastEditedAt,
      lastSyncedAt: detail.lastSyncedAt,
      lastPrunedAt: detail.lastPrunedAt,
      bytesOnDisk: detail.bytesOnDisk ?? cloudEntry?.size ?? null,
    })
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: now,
    files,
  }
}

export function localCachePatchFromCloudMetadata(cloud, metadata, now) {
  if (metadata.localCache) return metadata.localCache
  const visiblePaths = Object.keys(cloud.files ?? {})
  if (metadata.reason === 'attach') {
    return localCachePatchForPaths(cloud, visiblePaths, {
      now,
      state: 'cloud-only',
      bytesOnDisk: null,
    })
  }
  if (metadata.reason === 'dehydrate') {
    return localCachePatchForPaths(cloud, visiblePaths, {
      now,
      state: 'cloud-only',
      lastPrunedAt: now,
      bytesOnDisk: null,
    })
  }
  if (Array.isArray(metadata.prunedPaths) && metadata.prunedPaths.length > 0) {
    return localCachePatchForPaths(cloud, metadata.prunedPaths, {
      now,
      state: 'cloud-only',
      lastPrunedAt: now,
      bytesOnDisk: null,
    })
  }
  if (Array.isArray(metadata.syncedPaths) && metadata.syncedPaths.length > 0) {
    return localCachePatchForPaths(cloud, metadata.syncedPaths, {
      now,
      state: 'uploaded',
      lastEditedAt: now,
      lastSyncedAt: now,
    })
  }
  if (Array.isArray(metadata.hydratedPaths) && metadata.hydratedPaths.length > 0) {
    const hydratedState = metadata.reason === 'sync' || metadata.reason === 'recover'
      ? 'uploaded'
      : 'hydrated'
    return localCachePatchForPaths(cloud, metadata.hydratedPaths, {
      now,
      state: hydratedState,
      lastHydratedAt: hydratedState === 'hydrated' ? now : undefined,
      lastSyncedAt: hydratedState === 'uploaded' ? now : undefined,
    })
  }
  return null
}

export function mergeLocalCache(existing, incoming) {
  if (!existing && !incoming) return null
  const files = { ...(existing?.files ?? {}) }
  for (const [relativePath, patch] of Object.entries(incoming?.files ?? {})) {
    const previous = files[relativePath] ?? {}
    files[relativePath] = compactObject({
      ...previous,
      ...patch,
      pinned: patch.pinned === undefined ? Boolean(previous.pinned) : Boolean(patch.pinned),
    })
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: incoming?.updatedAt ?? existing?.updatedAt ?? null,
    files,
    summary: localCacheSummary({ files }),
  }
}

export function localCacheSnapshotForCloud(options, cloud, indexedCodebase) {
  const files = {}
  if (cloud?.files) {
    for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
      files[relativePath] = workspaceFileLocalState(options, relativePath, file, {
        indexedCodebase,
        forceExists: false,
        scanDisk: false,
      })
    }
  } else {
    for (const [relativePath, entry] of Object.entries(indexedCodebase?.localCache?.files ?? {})) {
      files[relativePath] = normalizePersistedLocalCacheEntry(entry)
    }
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: indexedCodebase?.localCache?.updatedAt ?? null,
    files,
    summary: localCacheSummary({ files }),
  }
}

export function normalizePersistedLocalCacheEntry(entry = {}) {
  const state = entry.state ?? 'cloud-only'
  const hydrated = state !== 'cloud-only'
  const pinned = Boolean(entry.pinned)
  const pending = state === 'pending-upload'
  const blocked = state === 'blocked'
  const dirty = state === 'dirty'
  const prunable = hydrated && !pinned && !pending && !blocked && !dirty

  return {
    exists: hydrated,
    hydrated,
    state,
    pinned,
    dirty,
    pending,
    blocked,
    prunable,
    bytesOnDisk: Number.isInteger(entry.bytesOnDisk) ? entry.bytesOnDisk : null,
    lastHydratedAt: entry.lastHydratedAt ?? null,
    lastEditedAt: entry.lastEditedAt ?? null,
    lastSyncedAt: entry.lastSyncedAt ?? null,
    lastPrunedAt: entry.lastPrunedAt ?? null,
  }
}

export function localCacheSummary(cache) {
  const counts = {}
  let pinnedFiles = 0
  let hydratedFiles = 0
  let prunableFiles = 0
  let bytesOnDisk = 0

  for (const entry of Object.values(cache?.files ?? {})) {
    const state = entry?.state ?? 'cloud-only'
    const pinned = Boolean(entry?.pinned)
    const pending = state === 'pending-upload' || Boolean(entry?.pending)
    const blocked = state === 'blocked' || Boolean(entry?.blocked)
    const dirty = state === 'dirty' || Boolean(entry?.dirty)
    const hydrated = Boolean(entry?.hydrated) || state !== 'cloud-only'
    const prunable = Boolean(entry?.prunable) || (hydrated && !pinned && !pending && !blocked && !dirty)
    counts[state] = (counts[state] ?? 0) + 1
    if (pinned) pinnedFiles += 1
    if (hydrated) hydratedFiles += 1
    if (prunable) prunableFiles += 1
    if (Number.isInteger(entry?.bytesOnDisk)) bytesOnDisk += entry.bytesOnDisk
  }

  return {
    fileCount: Object.keys(cache?.files ?? {}).length,
    hydratedFiles,
    pinnedFiles,
    prunableFiles,
    bytesOnDisk,
    states: counts,
  }
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

export function deletableCloudPathsForWorkspace(indexedCodebase, visibleCloudPaths) {
  const visible = uniqueCloudPaths(visibleCloudPaths)
  if (!indexedCodebase || indexedCodebase.hydration?.state === 'materialized') {
    return new Set(visible)
  }

  return new Set(uniqueCloudPaths(indexedCodebase.hydratedPaths ?? []).filter((relativePath) =>
    visible.includes(relativePath),
  ))
}

export function workspaceIndexHydrationStateForSync(indexedCodebase) {
  if (!indexedCodebase) return 'materialized'
  if (indexedCodebase.hydration?.state === 'metadata-only') return 'partial'
  if (indexedCodebase.hydration?.state === 'partial') return 'partial'
  return 'materialized'
}

export function hydratedPathsAfterSync(indexedCodebase, diskPaths, cloudPaths) {
  const existing =
    indexedCodebase?.hydration?.state === 'partial' || indexedCodebase?.hydration?.state === 'metadata-only'
      ? indexedCodebase.hydratedPaths ?? []
      : cloudPaths
  return uniqueCloudPaths([...existing, ...diskPaths])
}

export function hydratedPathsAfterPrune(indexedCodebase, visibleCloudPaths, prunedPaths) {
  const pruned = new Set(uniqueCloudPaths(prunedPaths))
  const existing =
    indexedCodebase?.hydration?.state === 'partial' || indexedCodebase?.hydration?.state === 'metadata-only'
      ? indexedCodebase.hydratedPaths ?? []
      : visibleCloudPaths
  return uniqueCloudPaths(existing.filter((relativePath) => !pruned.has(relativePath)))
}

export function hydrationStateForHydratedPaths(hydratedPaths, visibleCloudPaths) {
  const visible = uniqueCloudPaths(visibleCloudPaths)
  const hydrated = uniqueCloudPaths(hydratedPaths)
  if (hydrated.length === 0) return 'metadata-only'
  if (hydrated.length === visible.length && visible.every((relativePath) => hydrated.includes(relativePath))) {
    return 'materialized'
  }
  return 'partial'
}

export function materializationForHydrationState(hydrationState) {
  if (hydrationState === 'materialized') return 'managed-folder'
  if (hydrationState === 'partial') return 'partial-managed-folder'
  return 'metadata-only'
}

export function latestIsoTimestamp(values) {
  const timestamps = values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)
  return timestamps[0]?.value ?? null
}

export function emptyWorkspaceIndex(options) {
  return {
    schemaVersion: workspaceIndexVersion,
    updatedAt: null,
    root: workspaceIndexRoot(options),
    codebases: [],
  }
}

export function normalizeWorkspaceIndex(value, options) {
  if (!value || typeof value !== 'object') return emptyWorkspaceIndex(options)
  const codebases = Array.isArray(value.codebases)
    ? value.codebases.filter((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0)
    : []

  return {
    ...value,
    schemaVersion: workspaceIndexVersion,
    root: value.root && typeof value.root === 'object' ? value.root : workspaceIndexRoot(options),
    codebases,
  }
}

export function mergeIndexedCodebases(indexedCodebases, current) {
  const byId = new Map()
  for (const codebase of indexedCodebases ?? []) {
    if (codebase?.id) byId.set(workspaceIndexEntryKey(codebase), codebase)
  }
  if (current?.id) {
    const key = workspaceIndexEntryKey(current)
    const existing = byId.get(key) ?? {}
    const localCache = mergeLocalCache(existing.localCache, current.localCache)
    byId.set(key, {
      ...existing,
      ...current,
      ...(localCache ? { localCache } : {}),
    })
  }

  return [...byId.values()].sort((a, b) => {
    const nameCompare = String(a.name ?? a.id).localeCompare(String(b.name ?? b.id))
    return nameCompare || String(a.id).localeCompare(String(b.id))
  })
}

export function workspaceIndexEntryKey(entry) {
  const workspacePath = entry.workspace?.path ? path.resolve(entry.workspace.path) : '(unbound)'
  return `${entry.id}:${workspacePath}`
}

export function findIndexedCodebase(index, codebaseId, workspacePath = null) {
  if (!index || !codebaseId) return null
  const resolvedWorkspace = workspacePath ? path.resolve(workspacePath) : null
  return (
    (index.codebases ?? []).find((codebase) => {
      if (codebase.id !== codebaseId) return false
      if (!resolvedWorkspace) return true
      return path.resolve(codebase.workspace?.path ?? '') === resolvedWorkspace
    }) ?? null
  )
}

export function storableWorkspaceIndexEntry(entry) {
  if (!entry?.workspace?.index) return entry
  const { index: _index, ...workspace } = entry.workspace
  return {
    ...entry,
    workspace,
  }
}

export function workspaceIndexEntryFromCloud(options, cloud, metadata = {}) {
  const now = metadata.now ?? new Date().toISOString()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const hydrationState = metadata.hydrationState ?? 'materialized'
  const hydratedPaths = Array.isArray(metadata.hydratedPaths)
    ? uniqueCloudPaths(metadata.hydratedPaths)
    : hydrationState === 'materialized'
      ? Object.keys(cloud.files ?? {}).sort()
      : []
  const materializedRevision = hydrationState === 'materialized' ? (cloud.revision ?? null) : null
  const contentManifest = contentManifestFromCloud(cloud, hydratedPaths)
  const hydration = {
    state: hydrationState,
    lastMaterializedAt: now,
    lastMaterializedRevision: materializedRevision,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
    source: metadata.reason ?? 'unknown',
    lastEvent: metadata.lastEvent ?? null,
    hydratedPathCount: hydratedPaths.length,
  }
  const localCache = localCachePatchFromCloudMetadata(cloud, metadata, now)

  return {
    id: codebaseId,
    name: cloud.codebase?.name ?? codebaseId,
    initialized: true,
    workspace: {
      root: path.resolve(workspaceRootFromOptions(options)),
      path: path.resolve(options.workspace),
      exists: existsSync(options.workspace),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      virtualized: false,
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudServiceTypeFromOptions(options),
      exists: true,
    },
    activeChangeSetId: cloud.selectedState?.type === 'active-change-set' ? cloud.selectedState.id : null,
    mainId: cloud.main?.id ?? null,
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    hiddenFileCount: cloud.visibilityContext?.hiddenFileCount ?? null,
    materialization: metadata.materialization ?? (hydrationState === 'materialized' ? 'managed-folder' : 'metadata-only'),
    hydration,
    hydratedPaths,
    contentManifest,
    ...(localCache ? { localCache } : {}),
    remoteCursor: {
      graphRevision: cloud.revision ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
      materializedRevision: hydration.lastMaterializedRevision,
      lastMaterializedAt: hydration.lastMaterializedAt,
    },
    virtualized: false,
    updatedAt: now,
  }
}

export function workspaceIndexRoot(options) {
  return {
    path: path.resolve(workspaceRootFromOptions(options)),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    sourceOfTruth: workspaceMode.sourceOfTruth,
    virtualized: false,
  }
}

export function workspaceIndexPath(options) {
  return options['workspace-index'] ?? path.join(agentStateRootFromOptions(options), 'workspaces.json')
}

export function agentStateRootFromOptions(options) {
  return options['state-root'] ?? path.dirname(path.resolve(options.journal))
}

export function workspaceIndexSummary(options, index) {
  return {
    path: path.resolve(workspaceIndexPath(options)),
    exists: Boolean(index),
    schemaVersion: index?.schemaVersion ?? null,
    updatedAt: index?.updatedAt ?? null,
    codebaseCount: index?.codebases?.length ?? 0,
  }
}

