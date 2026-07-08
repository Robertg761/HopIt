// @ts-check
import { reachableBlobKeysForCloud, storageRetentionMsFromOptions } from '../blob-stores/index.js'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { emit } from '../io.js'

export async function manageStorage(options, args = []) {
  const action = args.find((arg) => !arg.startsWith('--')) ?? 'status'
  if (action === 'status') {
    await storageStatus(options)
    return
  }
  if (action === 'gc') {
    await storageGc(options)
    return
  }
  throw new Error(`Unknown storage action: ${action}`)
}

export async function storageStatus(options) {
  const cloudService = createCloudGraphService(options)
  if (!cloudService.blobStore) {
    throw new Error('storage status requires --blob-provider or HOPIT_BLOB_PROVIDER.')
  }
  const usage = await cloudService.blobStore.readUsage()
  const cloud = await cloudService.readGraph()
  const currentReachableKeys = reachableBlobKeysForCloud(cloud)
  const retainedVersionKeys = cloudService.retainedBlobKeysForFileVersions
    ? await cloudService.retainedBlobKeysForFileVersions(cloud.codebase?.id)
    : new Set()
  const reachableKeys = new Set([...currentReachableKeys, ...retainedVersionKeys])
  const result = {
    ok: true,
    action: 'storage.status',
    provider: cloudService.blobStore.provider,
    location: cloudService.blobStore.location,
    codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? null,
    usage,
    reachableObjects: reachableKeys.size,
    currentReferenceObjects: currentReachableKeys.size,
    retainedVersionReferenceObjects: retainedVersionKeys.size,
  }
  await emit(options, 'storage.status', result)
  console.log(JSON.stringify(result, null, 2))
}

export async function storageGc(options) {
  const cloudService = createCloudGraphService(options)
  if (!cloudService.blobStore) {
    throw new Error('storage gc requires --blob-provider or HOPIT_BLOB_PROVIDER.')
  }
  if (!cloudService.blobStore.listBlobs || !cloudService.blobStore.deleteBlob) {
    throw new Error(`storage gc is not supported by blob provider ${cloudService.blobStore.provider}.`)
  }

  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  const currentReachableKeys = reachableBlobKeysForCloud(cloud)
  const retainedVersionKeys = cloudService.retainedBlobKeysForFileVersions
    ? await cloudService.retainedBlobKeysForFileVersions(codebaseId)
    : new Set()
  const reachableKeys = new Set([...currentReachableKeys, ...retainedVersionKeys])
  const listed = await cloudService.blobStore.listBlobs({ codebaseId })
  const retentionMs = storageRetentionMsFromOptions(options)
  const now = Date.now()
  const orphaned = listed
    .filter((blob) => !reachableKeys.has(blob.key))
    .filter((blob) => {
      if (!retentionMs) return true
      if (!blob.lastModified) return false
      return now - new Date(blob.lastModified).getTime() >= retentionMs
    })
  const execute = Boolean(options.execute)
  let deleted = 0
  let deletedBytes = 0

  if (execute) {
    for (const blob of orphaned) {
      await cloudService.blobStore.deleteBlob(blob.key, { codebaseId })
      deleted += 1
      deletedBytes += blob.size ?? 0
    }
  }

  const result = {
    ok: true,
    action: 'storage.gc',
    mode: execute ? 'execute' : 'dry-run',
    provider: cloudService.blobStore.provider,
    location: cloudService.blobStore.location,
    codebaseId,
    listedObjects: listed.length,
    listedBytes: listed.reduce((sum, blob) => sum + (blob.size ?? 0), 0),
    reachableObjects: reachableKeys.size,
    currentReferenceObjects: currentReachableKeys.size,
    retainedVersionReferenceObjects: retainedVersionKeys.size,
    orphanedObjects: orphaned.length,
    orphanedBytes: orphaned.reduce((sum, blob) => sum + (blob.size ?? 0), 0),
    deletedObjects: deleted,
    deletedBytes,
    retentionMs,
    sampleOrphans: orphaned.slice(0, 20).map((blob) => ({
      key: blob.key,
      size: blob.size ?? null,
      lastModified: blob.lastModified ?? null,
    })),
  }
  await emit(options, execute ? 'storage.gc.deleted' : 'storage.gc.planned', result)
  console.log(JSON.stringify(result, null, 2))
}
