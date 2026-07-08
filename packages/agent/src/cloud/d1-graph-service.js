// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createObjectBlobStore, prepareEntryForBlobStorage, prepareGraphForBlobStorage } from '../blob-stores/index.js'
import { cloudServiceType, contentStorageMode, entryEncoding, entryKind, fileScope } from '../constants.js'
import { privacyZoneForPath, validateClientEncryptionMetadata } from '@hopit/core/crypto'
import { readJson, shouldUseD1Backend, writeJson } from '../io.js'
import { countPathScopes, normalizeCloudFileEntry, normalizeCloudScopes } from '../journal.js'
import { applyJournalEntryToCloud } from '../status-state.js'
import { assertSafeCloudPath } from '../workspace-manifest.js'
import { CloudflareD1HopBackend, d1CloudServiceType, d1ConfigFromOptions } from '@hopit/backend-d1'
import { attachTextDiff, buildFileVersionRows, compareVersionRows, createCompareBlobReader, retainedBlobKeysForVersions } from '@hopit/backend-d1'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { existsSync } from 'node:fs'

export function createCloudGraphService(options) {
  if (shouldUseD1Backend(options)) {
    return new D1CloudGraphService(options)
  }

  if (options.profile === 'production' && !options['allow-local-cloud']) {
    throw new Error('Production profile requires Cloudflare D1 backend configuration. Set HOPIT_CLOUD_BACKEND=d1 with HOPIT_D1_* values. Use --allow-local-cloud only for local dry runs.')
  }

  return new FixtureJsonCloudGraphService(options)
}

export class FixtureJsonCloudGraphService {
  constructor(options) {
    this.path = options.cloud
    this.type = cloudServiceType
    this.location = path.resolve(options.cloud)
    this.usesAtomicFileMutations = false
    this.blobStore = createObjectBlobStore(options)
  }

  async exists() {
    return existsSync(this.path)
  }

  async readGraphHead() {
    if (!(await this.exists())) return null
    return graphHeadFromGraph(await this.readGraph())
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
    await prepareGraphForBlobStorage(this, cloud)
    await this.writeGraph(cloud)
    return cloud
  }

  async readGraph() {
    return normalizeValidatedCloudGraph(await readJson(this.path))
  }

  async readVisibleGraph(request = {}) {
    return filterVisibleGraphForRequester(await this.readGraph(), request)
  }

  async readOptionalGraph() {
    if (!(await this.exists())) return null
    return this.readGraph()
  }

  async readOptionalVisibleGraph(request = {}) {
    if (!(await this.exists())) return null
    return this.readVisibleGraph(request)
  }

  async listCodebases(request = {}) {
    const graph = await this.readOptionalVisibleGraph(request)
    return graph ? [graphHeadFromGraph(graph)] : []
  }

  async writeGraph(cloud, options = {}) {
    const beforeGraph = (await this.exists()) ? await this.readGraph() : null
    const previousVersions = Array.isArray(beforeGraph?.fileVersions) ? beforeGraph.fileVersions : []
    const normalized = normalizeValidatedCloudGraph(cloud)
    await prepareGraphForBlobStorage(this, normalized)
    const versionRows = buildFileVersionRows({
      beforeGraph,
      afterGraph: normalized,
      createdAt: options.now ?? new Date().toISOString(),
      actor: options.actor ?? {},
    })
    const nextVersionId = previousVersions.reduce((max, row) => Math.max(max, Number(row.versionId ?? 0)), 0) + 1
    normalized.fileVersions = [
      ...previousVersions,
      ...versionRows.map((row, index) => ({ versionId: nextVersionId + index, ...row })),
    ]
    await writeJson(this.path, normalized)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const payload = options.entry
      ? await prepareEntryForBlobStorage(this.blobStore, cloud.codebase?.id ?? 'hopit', entry.path, options.entry)
      : null
    const acknowledgement = this.applyJournalEntry(cloud, entry, {
      ...options,
      entry: payload ?? options.entry,
    })
    await this.writeGraph(cloud, {
      now: options.now,
      actor: {
        actorUserId: entry.actorUserId ?? entry.ownerId ?? entry.userId ?? entry.requesterId ?? null,
        sessionId: entry.sessionId ?? cloud.session?.id ?? null,
        deviceName: entry.deviceName ?? cloud.session?.deviceName ?? null,
      },
    })
    return acknowledgement
  }

  async readBlob(file, context = {}) {
    if (!this.blobStore) throw new Error('Object-backed file requires HOPIT_BLOB_PROVIDER.')
    return await this.blobStore.getBlob(file, context)
  }

  async listFileVersions() {
    const cloud = await this.readGraph()
    return Array.isArray(cloud.fileVersions) ? cloud.fileVersions : []
  }

  async retainedBlobKeysForFileVersions() {
    return retainedBlobKeysForVersions(await this.listFileVersions())
  }

  async compareRevisions(leftRevision, rightRevision, requester = {}) {
    const cloud = await this.readGraph()
    const context = visibilityContextForGraph(cloud, requester)
    const result = compareVersionRows(await this.listFileVersions(), leftRevision, rightRevision, {
      canSeePath: (filePath) => canRequesterSeePath(context, filePath),
    })
    if (!result.ok) return result

    const diffPath = requester.path ?? requester.filePath ?? requester.diffPath ?? null
    if (diffPath) {
      const blobReader = createCompareBlobReader({
        readBlob: (file) => this.readBlob(file, requester),
      })
      await attachTextDiff(result, diffPath, blobReader.readFileBody)
      result.bodyFetches = blobReader.stats.fetches
      result.blobCacheHits = blobReader.stats.cacheHits
    }
    return result
  }
}

export class D1CloudGraphService extends CloudflareD1HopBackend {
  constructor(options) {
    super(d1ConfigFromOptions(options))
    this.codebaseId = options['codebase-id'] || process.env.HOPIT_CODEBASE_ID || this.codebaseId || null
    this.type = d1CloudServiceType
    this.location = this.codebaseId ? `d1:${this.codebaseId}` : `d1:${this.config.databaseId ?? 'unconfigured'}`
    this.usesAtomicFileMutations = false
    this.blobStore = createObjectBlobStore(options)
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
    this.codebaseId = cloud.codebase.id
    this.location = `d1:${this.codebaseId}`
    await prepareGraphForBlobStorage(this, cloud)
    await super.initialize(cloud)
    return cloud
  }

  async readGraph() {
    const graph = await this.readOptionalGraph()
    if (!graph) {
      throw new Error(`D1 graph not found for codebase ${this.codebaseId ?? '(unset)'}.`)
    }
    return graph
  }

  async readOptionalGraph() {
    const graph = await super.readOptionalGraph(this.codebaseId)
    return graph ? normalizeValidatedCloudGraph(graph) : null
  }

  async readGraphHead() {
    return normalizeCloudGraphHead(await super.readGraphHead(this.codebaseId))
  }

  async readVisibleGraph(request = {}) {
    return filterVisibleGraphForRequester(await this.readGraph(), request)
  }

  async readOptionalVisibleGraph(request = {}) {
    const graph = await this.readOptionalGraph()
    return graph ? filterVisibleGraphForRequester(graph, request) : null
  }

  async listCodebases(request = {}) {
    const codebases = await super.listCodebases({
      userId: request.requesterId,
      sessionId: request.sessionId,
    })
    return Array.isArray(codebases) ? codebases.map(normalizeCloudGraphHead).filter(Boolean) : []
  }

  async writeGraph(cloud, options = {}) {
    const normalized = normalizeValidatedCloudGraph(cloud)
    this.codebaseId = normalized.codebase.id
    this.location = `d1:${this.codebaseId}`
    await prepareGraphForBlobStorage(this, normalized)
    return await super.writeGraph(normalized, options)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const payload = options.entry
      ? await prepareEntryForBlobStorage(this.blobStore, cloud.codebase?.id ?? this.codebaseId ?? 'hopit', entry.path, options.entry)
      : null
    const acknowledgement = this.applyJournalEntry(cloud, entry, {
      ...options,
      entry: payload ?? options.entry,
    })
    await this.writeGraph(cloud, {
      now: options.now,
      actor: {
        actorUserId: entry.actorUserId ?? entry.ownerId ?? entry.userId ?? entry.requesterId ?? null,
        sessionId: entry.sessionId ?? cloud.session?.id ?? null,
        deviceName: entry.deviceName ?? cloud.session?.deviceName ?? null,
      },
    })
    return {
      ...acknowledgement,
      storageMode: 'd1-graph-save',
    }
  }

  async readBlob(file, context = {}) {
    if (!this.blobStore) throw new Error('Object-backed file requires HOPIT_BLOB_PROVIDER.')
    return await this.blobStore.getBlob(file, context)
  }
}

export async function removeEmptyAncestorDirectories(root, relativeDir) {
  let current = relativeDir

  while (current && current !== '.') {
    const absolutePath = path.join(root, current)

    try {
      await fs.rmdir(absolutePath)
    } catch {
      return
    }

    current = path.dirname(current)
  }
}

export function withComputedMetadata(cloud) {
  const next = normalizeCloudGraph(structuredClone(cloud))
  for (const [relativePath, file] of Object.entries(next.files)) {
    next.files[relativePath] = normalizeCloudFileEntry(relativePath, file)
  }
  validateCloudGraphContract(next)
  return next
}

export function normalizeValidatedCloudGraph(cloud) {
  validateRawCloudGraphContract(cloud)
  const normalized = normalizeCloudGraph(cloud)
  validateCloudGraphContract(normalized)
  return normalized
}

export function graphHeadFromGraph(cloud) {
  const graph = normalizeCloudGraph(structuredClone(cloud))
  return normalizeCloudGraphHead({
    exists: true,
    schemaVersion: graph.schemaVersion,
    codebase: graph.codebase,
    main: graph.main,
    selectedState: graph.selectedState,
    owner: graph.owner,
    session: graph.session,
    visibility: graph.visibility,
    access: graph.visibilityContext ?? null,
    revision: graph.revision,
    fileCount: Object.keys(graph.files ?? {}).length,
    privateFileCount: Object.keys(graph.files ?? {}).filter((filePath) => scopeForPath(filePath) === 'owner-private').length,
    memberCount: 1 + (Array.isArray(graph.collaborators) ? graph.collaborators.length : 0),
  })
}

export function normalizeCloudGraphHead(head) {
  if (!head || typeof head !== 'object') return null

  const codebase = objectOrNull(head.codebase)
  const main = objectOrNull(head.main)
  const selectedState = objectOrNull(head.selectedState)
  const owner = objectOrNull(head.owner)
  const session = objectOrNull(head.session)
  const access = objectOrNull(head.access)
  const remoteUpdate = objectOrNull(head.remoteUpdate)

  return {
    exists: head.exists !== false,
    schemaVersion: integerOrNull(head.schemaVersion),
    codebase: codebase
      ? {
          id: textOrNull(codebase.id),
          name: textOrNull(codebase.name) ?? textOrNull(codebase.id),
          ownerId: textOrNull(codebase.ownerId),
        }
      : null,
    main: main
      ? {
          id: textOrNull(main.id),
          revision: integerOrNull(main.revision),
        }
      : null,
    selectedState: selectedState
      ? {
          type: textOrNull(selectedState.type),
          id: textOrNull(selectedState.id),
          ownerId: textOrNull(selectedState.ownerId),
          baseMainId: textOrNull(selectedState.baseMainId),
          baseRevision: integerOrNull(selectedState.baseRevision),
          revision: integerOrNull(selectedState.revision),
          visibility: textOrNull(selectedState.visibility),
          effectiveVisibility: textOrNull(selectedState.effectiveVisibility),
          reviewState: textOrNull(selectedState.reviewState),
          mergeState: textOrNull(selectedState.mergeState),
          conflictState: textOrNull(selectedState.conflictState),
        }
      : null,
    owner: owner ? { id: textOrNull(owner.id) } : null,
    session: session
      ? {
          id: textOrNull(session.id),
          deviceName: textOrNull(session.deviceName),
        }
      : null,
    visibility: objectOrNull(head.visibility),
    access: access
      ? {
          id: textOrNull(access.id),
          sessionId: textOrNull(access.sessionId),
          role: textOrNull(access.role) ?? 'guest',
          isOwner: access.isOwner === true,
          isCollaborator: access.isCollaborator === true,
          membershipSource: textOrNull(access.membershipSource) ?? 'unknown',
          permissions: Array.isArray(access.permissions)
            ? access.permissions.filter((permission) => typeof permission === 'string')
            : [],
          visibleFileCount: integerOrNull(access.visibleFileCount),
          hiddenFileCount: integerOrNull(access.hiddenFileCount),
          hiddenScopeCounts: objectOrNull(access.hiddenScopeCounts),
        }
      : null,
    revision: integerOrNull(head.revision),
    fileCount: integerOrNull(head.fileCount),
    privateFileCount: integerOrNull(head.privateFileCount),
    memberCount: integerOrNull(head.memberCount),
    remoteUpdate: remoteUpdate
      ? {
          state: textOrNull(remoteUpdate.state),
          delivery: textOrNull(remoteUpdate.delivery),
          graphRevision: integerOrNull(remoteUpdate.graphRevision),
          mainRevision: integerOrNull(remoteUpdate.mainRevision),
          materializedRevision: integerOrNull(remoteUpdate.materializedRevision),
          selectedStateRevision: integerOrNull(remoteUpdate.selectedStateRevision),
          behindByRevisions: integerOrNull(remoteUpdate.behindByRevisions),
          safeRefreshOnly: remoteUpdate.safeRefreshOnly === true,
          localHydrationState: textOrNull(remoteUpdate.localHydrationState),
          updatedAt: textOrNull(remoteUpdate.updatedAt),
        }
      : null,
    updatedAt: textOrNull(head.updatedAt),
  }
}

export function normalizeCloudGraph(cloud) {
  if (!cloud || typeof cloud !== 'object') {
    throw new Error('Cloud graph must be an object.')
  }

  if (!cloud.files || typeof cloud.files !== 'object') cloud.files = {}
  if (!Number.isInteger(cloud.revision)) cloud.revision = 0

  cloud.schemaVersion = cloud.schemaVersion ?? 2
  cloud.codebase = cloud.codebase ?? {}
  cloud.codebase.id = cloud.codebase.id ?? 'hopit-core'
  cloud.codebase.name = cloud.codebase.name ?? cloud.codebase.id
  cloud.owner = cloud.owner ?? {}
  cloud.owner.id = cloud.owner.id ?? cloud.codebase.ownerId ?? 'user_demo_owner'
  cloud.codebase.ownerId = cloud.codebase.ownerId ?? cloud.owner.id
  cloud.collaborators = Array.isArray(cloud.collaborators) ? cloud.collaborators : []
  cloud.main = cloud.main ?? {}
  cloud.main.id = cloud.main.id ?? 'main'
  cloud.main.revision = Number.isInteger(cloud.main.revision) ? cloud.main.revision : cloud.revision
  cloud.main.updatedAt = cloud.main.updatedAt ?? null
  cloud.main.mergedChangeSetId = cloud.main.mergedChangeSetId ?? null
  cloud.selectedState = cloud.selectedState ?? {}
  cloud.selectedState.type = cloud.selectedState.type ?? 'active-change-set'
  cloud.selectedState.id = cloud.selectedState.id ?? 'cs_fixture_active'
  cloud.selectedState.ownerId = cloud.selectedState.ownerId ?? cloud.owner.id
  cloud.selectedState.baseMainId = cloud.selectedState.baseMainId ?? cloud.main.id
  cloud.selectedState.baseRevision = Number.isInteger(cloud.selectedState.baseRevision)
    ? cloud.selectedState.baseRevision
    : cloud.main.revision
  cloud.selectedState.revision = Number.isInteger(cloud.selectedState.revision)
    ? cloud.selectedState.revision
    : cloud.revision
  cloud.selectedState.reviewState = cloud.selectedState.reviewState ?? 'not-open'
  cloud.selectedState.mergeState = cloud.selectedState.mergeState ?? 'unmerged'
  cloud.selectedState.conflictState = cloud.selectedState.conflictState ?? 'none'
  cloud.selectedState.conflict = cloud.selectedState.conflict ?? null
  cloud.selectedState.review = cloud.selectedState.review ?? null
  cloud.selectedState.merge = cloud.selectedState.merge ?? null
  cloud.session = cloud.session ?? {}
  cloud.session.id = cloud.session.id ?? 'session_fixture_local'
  cloud.session.deviceName = cloud.session.deviceName ?? 'fixture-device'
  cloud.visibility = normalizeVisibilityContract(cloud.visibility)
  cloud.selectedState.visibility = cloud.selectedState.visibility ?? cloud.visibility.effective
  cloud.selectedState.effectiveVisibility = cloud.selectedState.effectiveVisibility ?? cloud.visibility.effective

  normalizeCloudScopes(cloud)
  return cloud
}

export function validateRawCloudGraphContract(cloud) {
  if (!cloud || typeof cloud !== 'object') {
    throw new Error('Cloud graph must be an object.')
  }
  if (cloud.files !== undefined && (!cloud.files || typeof cloud.files !== 'object' || Array.isArray(cloud.files))) {
    throw new Error('Cloud graph files must be an object.')
  }

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    assertSafeCloudPath(relativePath)
    if (file?.scope && file.scope !== scopeForPath(relativePath)) {
      throw new Error(`Cloud graph scope mismatch for ${relativePath}: expected ${scopeForPath(relativePath)}, got ${file.scope}.`)
    }
    if (file?.privacyZone && file.privacyZone !== privacyZoneForPath(relativePath)) {
      throw new Error(`Cloud graph privacy zone mismatch for ${relativePath}: expected ${privacyZoneForPath(relativePath)}, got ${file.privacyZone}.`)
    }
  }
}

export function validateCloudGraphContract(cloud) {
  const errors = []
  const visibilityValues = new Set(['private', 'team-visible', 'review-visible'])
  const reviewStates = new Set(['not-open', 'open', 'merged'])
  const mergeStates = new Set(['unmerged', 'merged'])
  const conflictStates = new Set(['none', 'conflicted'])

  if (cloud.schemaVersion !== 2) errors.push('schemaVersion must be 2.')
  if (!isNonEmptyString(cloud.codebase?.id)) errors.push('codebase.id is required.')
  if (!isNonEmptyString(cloud.codebase?.name)) errors.push('codebase.name is required.')
  if (!isNonEmptyString(cloud.codebase?.ownerId)) errors.push('codebase.ownerId is required.')
  if (!isNonEmptyString(cloud.owner?.id)) errors.push('owner.id is required.')
  if (cloud.codebase?.ownerId !== cloud.owner?.id) errors.push('codebase.ownerId must match owner.id.')
  if (!isNonEmptyString(cloud.main?.id)) errors.push('main.id is required.')
  if (!Number.isInteger(cloud.main?.revision)) errors.push('main.revision must be an integer.')
  if (!isNonEmptyString(cloud.selectedState?.type)) errors.push('selectedState.type is required.')
  if (cloud.selectedState?.type !== 'active-change-set' && cloud.selectedState?.type !== 'main') {
    errors.push('selectedState.type must be active-change-set or main.')
  }
  if (!isNonEmptyString(cloud.selectedState?.id)) errors.push('selectedState.id is required.')
  if (!Number.isInteger(cloud.selectedState?.revision)) errors.push('selectedState.revision must be an integer.')
  if (!Number.isInteger(cloud.revision)) errors.push('revision must be an integer.')
  if (!visibilityValues.has(cloud.visibility?.effective)) errors.push('visibility.effective is invalid.')
  if (!visibilityValues.has(cloud.selectedState?.effectiveVisibility)) {
    errors.push('selectedState.effectiveVisibility is invalid.')
  }
  if (!reviewStates.has(cloud.selectedState?.reviewState)) errors.push('selectedState.reviewState is invalid.')
  if (!mergeStates.has(cloud.selectedState?.mergeState)) errors.push('selectedState.mergeState is invalid.')
  if (!conflictStates.has(cloud.selectedState?.conflictState)) errors.push('selectedState.conflictState is invalid.')
  if (!isNonEmptyString(cloud.session?.id)) errors.push('session.id is required.')
  if (!isNonEmptyString(cloud.session?.deviceName)) errors.push('session.deviceName is required.')

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    try {
      assertSafeCloudPath(relativePath)
    } catch (error) {
      errors.push(error.message)
    }
    if (!file || typeof file !== 'object') errors.push(`${relativePath} must be a file object.`)
    const kind = file?.kind ?? entryKind.file
    if (!Object.values(entryKind).includes(kind)) errors.push(`${relativePath}.kind is invalid.`)
    if (kind === entryKind.file && typeof file?.content !== 'string') errors.push(`${relativePath}.content must be a string.`)
    if (kind === entryKind.file && file?.encoding !== undefined && !Object.values(entryEncoding).includes(file.encoding)) {
      errors.push(`${relativePath}.encoding is invalid.`)
    }
    if (kind === entryKind.file && file?.contentStorage !== undefined && !Object.values(contentStorageMode).includes(file.contentStorage)) {
      errors.push(`${relativePath}.contentStorage is invalid.`)
    }
    if (kind === entryKind.file && file?.contentStorage === contentStorageMode.objectBlob) {
      if (!isNonEmptyString(file.blobProvider)) errors.push(`${relativePath}.blobProvider is required for object-backed files.`)
      if (!isNonEmptyString(file.blobKey)) errors.push(`${relativePath}.blobKey is required for object-backed files.`)
      if (!isNonEmptyString(file.blobHash ?? file.hash)) errors.push(`${relativePath}.blobHash is required for object-backed files.`)
      errors.push(...validateClientEncryptionMetadata(file.clientEncryption, `${relativePath}.clientEncryption`))
    }
    if (
      kind === entryKind.file &&
      privacyZoneForPath(relativePath) === 'secrets' &&
      !(
        file?.contentStorage === contentStorageMode.objectBlob &&
        file?.clientEncryption?.state === 'client-encrypted' &&
        validateClientEncryptionMetadata(file.clientEncryption, `${relativePath}.clientEncryption`).length === 0
      )
    ) {
      errors.push(`${relativePath} must be stored as encrypted object-backed content because it is in the secrets privacy zone.`)
    }
    if (kind === entryKind.symlink && typeof file?.target !== 'string') errors.push(`${relativePath}.target must be a string.`)
    if (kind === entryKind.directory && file?.content !== '') errors.push(`${relativePath}.content must be empty for directories.`)
    if (file?.scope !== scopeForPath(relativePath)) {
      errors.push(`${relativePath}.scope must be ${scopeForPath(relativePath)}.`)
    }
    if (file?.privacyZone !== undefined && file.privacyZone !== privacyZoneForPath(relativePath)) {
      errors.push(`${relativePath}.privacyZone must be ${privacyZoneForPath(relativePath)}.`)
    }
    if (!Number.isInteger(file?.revision)) errors.push(`${relativePath}.revision must be an integer.`)
    if (file?.hash !== undefined && file.hash !== null && typeof file.hash !== 'string') {
      errors.push(`${relativePath}.hash must be a string when present.`)
    }
    if (file?.size !== undefined && file.size !== null && !Number.isInteger(file.size)) {
      errors.push(`${relativePath}.size must be an integer when present.`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid HopIt cloud graph: ${errors.join(' ')}`)
  }
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

export function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function visibilityRequestFromOptions(options) {
  return {
    requesterId: options['requester-id'] ?? options.requester,
    sessionId: options['session-id'] ?? options['requester-session'],
  }
}

export function filterVisibleGraphForRequester(cloud, request = {}) {
  const graph = normalizeCloudGraph(structuredClone(cloud))
  const context = visibilityContextForGraph(graph, request)
  const files = {}
  const hiddenPaths = []

  for (const [relativePath, file] of Object.entries(graph.files ?? {})) {
    if (!canRequesterSeePath(context, relativePath)) {
      hiddenPaths.push(relativePath)
      continue
    }
    files[relativePath] = file
  }

  graph.files = files
  graph.visibilityContext = {
    ...context,
    visibleFileCount: Object.keys(files).length,
    hiddenFileCount: hiddenPaths.length,
    hiddenScopeCounts: countPathScopes(hiddenPaths),
  }

  return graph
}

export function visibilityContextForGraph(cloud, request = {}) {
  if (!request.requesterId && !request.sessionId && cloud.visibilityContext) {
    return cloud.visibilityContext
  }

  const ownerId = cloud.owner?.id ?? cloud.codebase?.ownerId ?? null
  const requesterId = request.requesterId ?? ownerId
  const collaborator = (cloud.collaborators ?? []).find((entry) => entry.id === requesterId) ?? null
  const isOwner = Boolean(ownerId && requesterId === ownerId)
  const isCollaborator = Boolean(collaborator)
  const effectiveVisibility = effectiveChangeSetVisibilityForCloud(cloud)

  return {
    id: requesterId,
    sessionId: request.sessionId ?? (isOwner ? cloud.session?.id : null),
    ownerId,
    role: isOwner ? 'owner' : isCollaborator ? (collaborator.role ?? 'member') : 'guest',
    isOwner,
    isCollaborator,
    selectedStateType: cloud.selectedState?.type ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    effectiveChangeSetVisibility: effectiveVisibility,
  }
}

export function canRequesterSeePath(context, relativePath) {
  if (context.isOwner) return true
  if (scopeForPath(relativePath) === fileScope.ownerPrivate) return false
  if (!context.isCollaborator) return false

  if (context.selectedStateType === 'main') return true

  return (
    context.effectiveChangeSetVisibility === 'team-visible' ||
    context.effectiveChangeSetVisibility === 'review-visible'
  )
}

export function effectiveChangeSetVisibilityForCloud(cloud) {
  return cloud?.selectedState?.effectiveVisibility ?? cloud?.visibility?.effective ?? 'private'
}

export function summarizeRequester(context) {
  if (!context) return null

  return {
    id: context.id ?? null,
    sessionId: context.sessionId ?? null,
    role: context.role ?? null,
    isOwner: Boolean(context.isOwner),
    isCollaborator: Boolean(context.isCollaborator),
    selectedStateId: context.selectedStateId ?? null,
    effectiveChangeSetVisibility: context.effectiveChangeSetVisibility ?? null,
    visibleFileCount: context.visibleFileCount ?? null,
    hiddenFileCount: context.hiddenFileCount ?? null,
    hiddenScopeCounts: context.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }
}

export function normalizeVisibilityContract(visibility = {}) {
  const productDefault = visibility.productDefault ?? 'private'
  const effective =
    visibility.changeSetOverride ??
    visibility.codebaseOverride ??
    visibility.globalUserDefault ??
    visibility.effective ??
    productDefault

  return {
    productDefault,
    globalUserDefault: visibility.globalUserDefault ?? null,
    codebaseOverride: visibility.codebaseOverride ?? null,
    changeSetOverride: visibility.changeSetOverride ?? null,
    effective,
  }
}

export function summarizeGraphContract(cloud) {
  return {
    schemaVersion: cloud?.schemaVersion ?? null,
    codebaseId: cloud?.codebase?.id ?? null,
    mainId: cloud?.main?.id ?? null,
    selectedStateType: cloud?.selectedState?.type ?? null,
    selectedStateId: cloud?.selectedState?.id ?? null,
    selectedStateRevision: cloud?.selectedState?.revision ?? null,
    ownerId: cloud?.owner?.id ?? cloud?.codebase?.ownerId ?? null,
    sessionId: cloud?.session?.id ?? null,
    effectiveChangeSetVisibility:
      cloud?.selectedState?.effectiveVisibility ?? cloud?.visibility?.effective ?? null,
  }
}
