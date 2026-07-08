// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService, graphHeadFromGraph } from '../cloud/d1-graph-service.js'
import { entryKind, workspaceMode } from '../constants.js'
import { privacyZoneForPath } from '@hopit/core/crypto'
import { readNdjson, writeJson } from '../io.js'
import { countCloudScopes, normalizeCloudFileEntry } from '../journal.js'
import { assertWorkspacePathSafe, cloudLocationFromOptions } from '../paths.js'
import { classifyJournalEntries, readAgentState, workspaceRootFromOptions } from '../status-state.js'
import { findIndexedCodebase, localCacheSummary, mergeIndexedCodebases, readWorkspaceIndex, upsertWorkspaceIndex, workspaceIndexSummary } from '../workspace-index.js'
import { manifestEntryChanged, readWorkspaceFiles, workspaceFilePath } from '../workspace-manifest.js'
import { attachWorkspace, dehydrateWorkspace, discoverWorkspaces, hydrateWorkspaceFile, hydrateWorkspacePath, openWorkspace, pruneWorkspaceCache, setWorkspaceCachePin } from './hydrate.js'
import { existsSync } from 'node:fs'

export async function runWorkspaceCommand(action, options) {
  const allowedActions = new Set([
    'status',
    'list',
    'discover',
    'ensure',
    'attach',
    'open',
    'files',
    'hydrate-file',
    'hydrate-path',
    'prune',
    'pin',
    'unpin',
    'dehydrate',
  ])
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown workspace action: ${action}`)
  }

  if (action === 'discover' || action === 'list') {
    await discoverWorkspaces(options, { action })
    return
  }

  if (action === 'attach') {
    await attachWorkspace(options)
    return
  }

  if (action === 'open') {
    await openWorkspace(options)
    return
  }

  if (action === 'hydrate-file') {
    if (!options.path && !options.file) {
      throw new Error('workspace hydrate-file requires --path <cloud-path>.')
    }
    await hydrateWorkspaceFile(options)
    return
  }

  if (action === 'hydrate-path') {
    if (!options.path && !options.file) {
      throw new Error('workspace hydrate-path requires --path <cloud-path>.')
    }
    await hydrateWorkspacePath(options)
    return
  }

  if (action === 'prune') {
    await pruneWorkspaceCache(options)
    return
  }

  if (action === 'pin') {
    await setWorkspaceCachePin(options, true)
    return
  }

  if (action === 'unpin') {
    await setWorkspaceCachePin(options, false)
    return
  }

  if (action === 'dehydrate') {
    await dehydrateWorkspace(options)
    return
  }

  if (action === 'ensure') {
    await assertWorkspacePathSafe(options)
    createCloudGraphService(options)
    await fs.mkdir(workspaceRootFromOptions(options), { recursive: true })
    await fs.mkdir(options.workspace, { recursive: true })
  }

  const state = await readAgentState(options)
  const rootPath = path.resolve(workspaceRootFromOptions(options))
  let current = workspaceCodebaseSummary(options, state)
  const index = action === 'ensure'
    ? await upsertWorkspaceIndex(options, current)
    : await readWorkspaceIndex(options)
  const cloud = state.cloud.graph
  if (current) {
    current = {
      ...current,
      workspace: {
        ...current.workspace,
        index: workspaceIndexSummary(options, index),
      },
    }
  }
  const indexedCodebases = mergeIndexedCodebases(index?.codebases ?? [], current)
  const result = {
    ok: true,
    action,
    root: {
      path: rootPath,
      exists: existsSync(rootPath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      sourceOfTruth: workspaceMode.sourceOfTruth,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      remoteUpdatePolicy: workspaceMode.remoteUpdatePolicy,
      virtualized: false,
      index: workspaceIndexSummary(options, index),
      note: 'HopIt currently uses managed folders under this root, not a FUSE or OS filesystem provider.',
    },
    current,
    codebases: indexedCodebases,
  }

  if (action === 'files') {
    const [diskEntries, journalEntries, eventEntries] = await Promise.all([
      readWorkspaceFiles(options.workspace, options),
      readNdjson(options.journal),
      readNdjson(options.events),
    ])
    const journalState = classifyJournalEntries(journalEntries, eventEntries)
    const indexedCodebase = findIndexedCodebase(index, cloud?.codebase?.id ?? options['codebase-id'], options.workspace)
    result.files = cloud
      ? Object.entries(cloud.files ?? {}).map(([relativePath, file]) =>
          workspaceFileMetadata(options, relativePath, file, {
            diskEntries,
            journalState,
            indexedCodebase,
          }),
        )
      : []
    result.summary = {
      visibleFiles: result.files.length,
      hydratedFiles: result.files.filter((file) => file.local.exists).length,
      dirtyFiles: result.files.filter((file) => file.local.dirty).length,
      pendingFiles: result.files.filter((file) => file.local.pending).length,
      pinnedFiles: result.files.filter((file) => file.local.pinned).length,
      prunableFiles: result.files.filter((file) => file.local.prunable).length,
      materialization: current?.materialization ?? 'unknown',
      hydration: current?.hydration ?? null,
      cache: localCacheSummary({
        files: Object.fromEntries(result.files.map((file) => [file.path, file.local])),
      }),
    }
  }

  console.log(JSON.stringify(result, null, 2))
}

export function workspaceCodebaseSummary(options, state) {
  const status = state.status
  const codebaseId = status.codebaseId ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const hydrationState = status.workspace.hydration?.state ?? null
  const materialization =
    hydrationState === 'metadata-only'
      ? 'metadata-only'
      : hydrationState === 'partial'
        ? 'partial-managed-folder'
        : 'managed-folder'

  return {
    id: codebaseId,
    name: status.codebaseName ?? codebaseId,
    initialized: status.readiness !== 'not_initialized',
    workspace: status.workspace,
    workspaceMode,
    cloud: {
      path: status.cloud.path,
      service: status.cloud.service,
      exists: status.cloud.exists,
    },
    activeChangeSetId: status.activeChangeSetId,
    mainId: status.mainId,
    visibleFileCount: status.visibleFileCount,
    hiddenFileCount: status.hiddenFileCount,
    materialization,
    hydration: status.workspace.hydration,
    openHydration: status.workspace.openHydration ?? null,
    localChanges: status.workspace.localChanges,
    contentManifest: status.workspace.contentManifest,
    remoteCursor: status.remotePull.cursor,
    virtualized: false,
  }
}

export function discoveredCloudCodebase(options, cloud, index, cloudService) {
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const codebaseOptions = workspaceOptionsForCloudCodebase(options, cloud)
  const indexedCodebase =
    findIndexedCodebase(index, codebaseId, codebaseOptions.workspace) ??
    findIndexedCodebase(index, codebaseId)
  const workspacePath = path.resolve(indexedCodebase?.workspace?.path ?? codebaseOptions.workspace)
  const workspaceRoot = path.resolve(indexedCodebase?.workspace?.root ?? workspaceRootFromOptions(codebaseOptions))

  return {
    id: codebaseId,
    name: cloud.codebase?.name ?? codebaseId,
    source: 'configured-cloud',
    attached: Boolean(indexedCodebase),
    available: true,
    initialized: true,
    workspace: {
      root: workspaceRoot,
      path: workspacePath,
      exists: existsSync(workspacePath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      virtualized: false,
      hydration: indexedCodebase?.hydration ?? { state: 'not_attached' },
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudService.type,
      exists: true,
    },
    ownerId: cloud.codebase?.ownerId ?? cloud.owner?.id ?? null,
    activeChangeSetId: cloud.selectedState?.type === 'active-change-set' ? cloud.selectedState.id : null,
    mainId: cloud.main?.id ?? null,
    selectedState: {
      type: cloud.selectedState?.type ?? null,
      id: cloud.selectedState?.id ?? null,
      revision: cloud.selectedState?.revision ?? null,
      visibility: cloud.selectedState?.effectiveVisibility ?? cloud.visibility?.effective ?? null,
    },
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    hiddenFileCount: cloud.visibilityContext?.hiddenFileCount ?? null,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? null,
    materialization: indexedCodebase?.materialization ?? 'not-attached',
    remoteCursor: discoveryRemoteCursor(indexedCodebase, graphHeadFromGraph(cloud)),
    remoteUpdate: discoveryRemoteUpdate(indexedCodebase, graphHeadFromGraph(cloud)),
    virtualized: false,
    updatedAt: cloud.updatedAt ?? null,
  }
}

export function discoveredCloudCodebaseHead(options, head, index, cloudService) {
  const codebaseId = head.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const codebaseOptions = workspaceOptionsForCodebaseId(options, codebaseId)
  const indexedCodebase =
    findIndexedCodebase(index, codebaseId, codebaseOptions.workspace) ??
    findIndexedCodebase(index, codebaseId)
  const workspacePath = path.resolve(indexedCodebase?.workspace?.path ?? codebaseOptions.workspace)
  const workspaceRoot = path.resolve(indexedCodebase?.workspace?.root ?? workspaceRootFromOptions(codebaseOptions))
  const remoteCursor = discoveryRemoteCursor(indexedCodebase, head)
  const fileCount = head.access?.visibleFileCount ?? head.fileCount ?? 0
  const privateFileCount = head.privateFileCount ?? 0

  return {
    id: codebaseId,
    name: head.codebase?.name ?? codebaseId,
    source: 'account-cloud',
    attached: Boolean(indexedCodebase),
    available: head.exists !== false,
    initialized: head.exists !== false,
    workspace: {
      root: workspaceRoot,
      path: workspacePath,
      exists: existsSync(workspacePath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      virtualized: false,
      hydration: indexedCodebase?.hydration ?? { state: 'not_attached' },
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudService.type,
      exists: head.exists !== false,
    },
    ownerId: head.codebase?.ownerId ?? head.owner?.id ?? null,
    activeChangeSetId: head.selectedState?.type === 'active-change-set' ? head.selectedState.id : null,
    mainId: head.main?.id ?? null,
    selectedState: {
      type: head.selectedState?.type ?? null,
      id: head.selectedState?.id ?? null,
      revision: head.selectedState?.revision ?? null,
      visibility: head.selectedState?.effectiveVisibility ?? head.visibility?.effective ?? null,
      reviewState: head.selectedState?.reviewState ?? null,
      mergeState: head.selectedState?.mergeState ?? null,
      conflictState: head.selectedState?.conflictState ?? null,
    },
    access: head.access ?? null,
    visibleFileCount: fileCount,
    hiddenFileCount: head.access?.hiddenFileCount ?? null,
    privateFileCount,
    memberCount: head.memberCount ?? null,
    scopeCounts: {
      shared: Math.max(0, (head.fileCount ?? fileCount) - privateFileCount),
      private: privateFileCount,
    },
    hiddenScopeCounts: head.access?.hiddenScopeCounts ?? null,
    materialization: indexedCodebase?.materialization ?? 'not-attached',
    remoteCursor,
    remoteUpdate: discoveryRemoteUpdate(indexedCodebase, head, remoteCursor),
    virtualized: false,
    updatedAt: head.updatedAt ?? head.remoteUpdate?.updatedAt ?? null,
  }
}

export function workspaceOptionsForCloudCodebase(options, cloud) {
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  return workspaceOptionsForCodebaseId(options, codebaseId)
}

export function workspaceOptionsForCodebaseId(options, codebaseId) {
  const next = {
    ...options,
    'codebase-id': codebaseId,
  }

  if (!options._provided?.has('workspace')) {
    next.workspace = path.join(workspaceRootFromOptions(options), workspaceFolderNameForCodebase(codebaseId))
  }

  return next
}

export function discoveryRemoteCursor(indexedCodebase, head) {
  const graphRevision = head.remoteUpdate?.graphRevision ?? head.revision ?? null
  const materializedRevision =
    indexedCodebase?.remoteCursor?.materializedRevision ??
    indexedCodebase?.hydration?.lastMaterializedRevision ??
    null
  return {
    graphRevision,
    selectedStateId: head.selectedState?.id ?? null,
    selectedStateType: head.selectedState?.type ?? null,
    selectedStateRevision: head.selectedState?.revision ?? head.remoteUpdate?.selectedStateRevision ?? null,
    materializedRevision,
    lastMaterializedAt:
      indexedCodebase?.remoteCursor?.lastMaterializedAt ??
      indexedCodebase?.hydration?.lastMaterializedAt ??
      null,
    behindByRevisions:
      Number.isInteger(graphRevision) && Number.isInteger(materializedRevision)
        ? Math.max(0, graphRevision - materializedRevision)
        : null,
  }
}

export function discoveryRemoteUpdate(indexedCodebase, head, cursor = discoveryRemoteCursor(indexedCodebase, head)) {
  const hydrationState = indexedCodebase?.hydration?.state ?? 'not_attached'
  const behindByRevisions = cursor.behindByRevisions
  const state = !indexedCodebase
    ? 'not-attached'
    : hydrationState === 'metadata-only' || hydrationState === 'partial'
      ? 'needs-hydration'
      : behindByRevisions === null
        ? 'unknown'
        : behindByRevisions > 0
          ? 'behind'
          : 'ready'

  return {
    state,
    delivery: head.remoteUpdate?.delivery ?? 'manual-or-activity-gated',
    graphRevision: cursor.graphRevision,
    materializedRevision: cursor.materializedRevision,
    selectedStateRevision: cursor.selectedStateRevision,
    behindByRevisions,
    safeRefreshOnly: true,
    localHydrationState: hydrationState,
    updatedAt: head.updatedAt ?? head.remoteUpdate?.updatedAt ?? null,
  }
}

export function workspaceFolderNameForCodebase(codebaseId) {
  return String(codebaseId ?? 'codebase')
    .replace(/[\\/]+/g, '-')
    .replace(/^\.+$/, 'codebase')
}

export async function assertAttachWorkspaceSafe(options, cloud, index) {
  if (options.force) return
  if (!existsSync(options.workspace)) return

  const codebaseId = cloud.codebase?.id ?? options['codebase-id']
  if (findIndexedCodebase(index, codebaseId, options.workspace)) return

  const unmanagedFiles = await readWorkspaceFiles(options.workspace, options)
  if (Object.keys(unmanagedFiles).length === 0) return

  throw new Error(
    'workspace attach refuses to bind a non-empty unmanaged folder. Choose an empty workspace folder or use the existing indexed workspace.',
  )
}

export function workspaceFileMetadata(options, relativePath, file, context = {}) {
  const metadataContext = typeof context === 'boolean' ? { forceExists: context } : context
  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  const entry = normalizeCloudFileEntry(relativePath, file)
  const local = workspaceFileLocalState(options, relativePath, file, metadataContext)
  return {
    path: relativePath,
    kind: entry.kind,
    scope: entry.scope,
    privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
    revision: entry.revision ?? null,
    size: entry.size,
    hash: entry.hash,
    encoding: entry.kind === entryKind.file ? entry.encoding : null,
    target: entry.target ?? null,
    local: {
      path: absolutePath,
      ...local,
    },
  }
}

export function workspaceFileLocalState(options, relativePath, file, context = {}) {
  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  const cached = context.indexedCodebase?.localCache?.files?.[relativePath] ?? {}
  const diskEntry = context.diskEntries?.[relativePath] ?? null
  const shouldCheckDisk = context.scanDisk !== false
  const cachedHydrated = cached.state && cached.state !== 'cloud-only'
  const exists = Boolean(context.forceExists || diskEntry || (shouldCheckDisk ? existsSync(absolutePath) : cachedHydrated))
  const effectiveDiskEntry = diskEntry ?? (context.forceExists ? normalizeCloudFileEntry(relativePath, file) : null)
  const manifestEntry = context.indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
  const pathJournalEntries = (context.journalState?.entries ?? []).filter((entry) => entry.path === relativePath)
  const pending = pathJournalEntries.some((entry) => entry.recoveryStatus === 'pending')
  const failed = pathJournalEntries.some((entry) => entry.recoveryStatus === 'failed')
  const dirty = Boolean(
    exists &&
      effectiveDiskEntry &&
      (!manifestEntry || manifestEntryChanged(manifestEntry, normalizeCloudFileEntry(relativePath, effectiveDiskEntry))),
  )
  const pinned = Boolean(cached.pinned)
  let state = cached.state ?? (exists ? 'hydrated' : 'cloud-only')

  if (failed || cached.state === 'blocked') state = 'blocked'
  else if (pending) state = 'pending-upload'
  else if (dirty) state = 'dirty'
  else if (!exists) state = 'cloud-only'
  else if (pinned) state = 'pinned'
  else if (cached.lastSyncedAt || cached.state === 'uploaded') state = 'uploaded'
  else state = 'hydrated'

  const hydrated = exists && state !== 'cloud-only'
  const clean = hydrated && !dirty && !pending && !failed
  const prunable = clean && !pinned
  const bytesOnDisk = exists
    ? Number.isInteger(effectiveDiskEntry?.size)
      ? effectiveDiskEntry.size
      : Number.isInteger(cached.bytesOnDisk)
        ? cached.bytesOnDisk
        : null
    : null

  return {
    exists,
    hydrated,
    state,
    pinned,
    dirty,
    pending,
    blocked: failed,
    prunable,
    bytesOnDisk,
    lastHydratedAt: cached.lastHydratedAt ?? null,
    lastEditedAt: cached.lastEditedAt ?? null,
    lastSyncedAt: cached.lastSyncedAt ?? null,
    lastPrunedAt: cached.lastPrunedAt ?? null,
  }
}

export async function writeWorkspaceMetadataManifest(options, cloud, detail = {}) {
  await fs.mkdir(path.join(options.workspace, '.hopit'), { recursive: true })
  const files = Object.entries(cloud.files ?? {}).map(([relativePath, file]) => {
    const entry = normalizeCloudFileEntry(relativePath, file)
    return {
      path: relativePath,
      kind: entry.kind,
      scope: entry.scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: entry.revision ?? null,
      size: entry.size,
      hash: entry.hash,
      target: entry.target ?? null,
    }
  })
  await writeJson(path.join(options.workspace, '.hopit', 'metadata.json'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    codebase: cloud.codebase,
    main: cloud.main,
    selectedState: {
      type: cloud.selectedState?.type ?? null,
      id: cloud.selectedState?.id ?? null,
      revision: cloud.selectedState?.revision ?? null,
      visibility: cloud.selectedState?.effectiveVisibility ?? cloud.visibility?.effective ?? null,
    },
    materialization: detail.materialization ?? 'metadata-only',
    fileCount: files.length,
    files,
  })
}
