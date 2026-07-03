// @ts-check
import path from 'node:path'
import { isNonEmptyString, summarizeGraphContract } from './cloud/d1-graph-service.js'
import { contentStorageMode, entryEncoding, entryKind, fileScope } from './constants.js'
import { normalizeClientEncryptionMetadata, privacyZoneForPath } from '@hopit/core/crypto'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { createHash } from 'node:crypto'

export function journalContextForCloud(cloud) {
  const contract = summarizeGraphContract(cloud)
  return {
    targetStateType: contract.selectedStateType,
    targetStateId: contract.selectedStateId,
    targetStateRevision: contract.selectedStateRevision,
    ownerId: contract.ownerId,
    sessionId: contract.sessionId,
    effectiveChangeSetVisibility: contract.effectiveChangeSetVisibility,
  }
}

export function actorIdFromOptions(options, cloud) {
  return options['requester-id'] ?? options.requester ?? cloud.owner?.id ?? cloud.codebase?.ownerId ?? null
}

export function ensureActiveChangeSet(cloud) {
  if (cloud.selectedState?.type !== 'active-change-set') {
    throw new Error('Selected state must be an active change set.')
  }
  if (!cloud.selectedState.id) {
    throw new Error('Selected active change set is missing id.')
  }
}

export function recordChangeSetConflict(cloud, detail) {
  ensureActiveChangeSet(cloud)

  const conflict = {
    state: 'conflicted',
    selectedStateId: cloud.selectedState.id,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main?.id ?? null,
    mainRevision: cloud.main?.revision ?? null,
    ...detail,
  }

  cloud.selectedState.conflictState = 'conflicted'
  cloud.selectedState.conflict = conflict
  return conflict
}

export function normalizeCloudScopes(cloud) {
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    cloud.files[relativePath] = normalizeCloudFileEntry(relativePath, file)
  }
}

export function countCloudScopes(cloud) {
  return countPathScopes(cloud?.files ? Object.keys(cloud.files) : [])
}

export function countEntryScopes(entries) {
  return countScopes(entries.map((entry) => entry.scope ?? scopeForPath(entry.path ?? '')))
}

export function countPathScopes(paths) {
  return countScopes(paths.map((relativePath) => scopeForPath(relativePath)))
}

export function countScopes(scopes) {
  const counts = {
    shared: 0,
    private: 0,
  }

  for (const scope of scopes) {
    if (scope === fileScope.ownerPrivate) {
      counts.private += 1
    } else {
      counts.shared += 1
    }
  }

  return counts
}

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function hashSymlinkTarget(target) {
  return hashContent(`symlink\0${target}`)
}

export function hashDirectoryEntry(relativePath) {
  return hashContent(`directory\0${relativePath}`)
}

export function encodeBufferForCloud(buffer) {
  if (isRoundTrippableUtf8(buffer) && !buffer.includes(0)) {
    return {
      content: buffer.toString('utf8'),
      encoding: entryEncoding.utf8,
    }
  }

  return {
    content: buffer.toString('base64'),
    encoding: entryEncoding.base64,
  }
}

export function isRoundTrippableUtf8(buffer) {
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer)
}

export function normalizeCloudFileEntry(relativePath, file) {
  const value = file && typeof file === 'object' ? { ...file } : { content: '' }
  value.kind = value.kind ?? entryKind.file
  value.scope = scopeForPath(relativePath)
  value.privacyZone = privacyZoneForPath(relativePath)

  if (value.kind === entryKind.directory) {
    value.content = ''
    value.encoding = entryEncoding.utf8
    value.target = null
    value.size = 0
    value.hash = typeof value.hash === 'string' ? value.hash : hashDirectoryEntry(relativePath)
    return value
  }

  if (value.kind === entryKind.symlink) {
    value.target = typeof value.target === 'string' ? value.target : String(value.content ?? '')
    value.content = value.target
    value.encoding = entryEncoding.utf8
    value.size = Number.isInteger(value.size) ? value.size : Buffer.byteLength(value.target)
    value.hash = typeof value.hash === 'string' ? value.hash : hashSymlinkTarget(value.target)
    return value
  }

  value.kind = entryKind.file
  value.encoding = value.encoding === entryEncoding.base64 ? entryEncoding.base64 : entryEncoding.utf8
  value.content = typeof value.content === 'string' ? value.content : ''
  value.contentStorage = normalizeContentStorageMode(value.contentStorage)
  value.blobProvider = typeof value.blobProvider === 'string' ? value.blobProvider : null
  value.blobKey = typeof value.blobKey === 'string' ? value.blobKey : null
  value.blobHash = typeof value.blobHash === 'string' ? value.blobHash : (typeof value.hash === 'string' ? value.hash : null)
  value.blobSize = Number.isInteger(value.blobSize) ? value.blobSize : null
  value.clientEncryption = normalizeClientEncryptionMetadata(value.clientEncryption)
  const buffer = bufferFromFileEntry(value)
  value.size = Number.isInteger(value.size) ? value.size : buffer.byteLength
  value.hash = typeof value.hash === 'string' ? value.hash : (isNonEmptyString(value.blobHash) ? value.blobHash : hashBuffer(buffer))
  if (!value.blobHash) value.blobHash = value.hash
  if (!value.blobSize && value.contentStorage === contentStorageMode.objectBlob) value.blobSize = value.size
  return value
}

export function bufferFromFileEntry(file) {
  if (file.kind && file.kind !== entryKind.file) return Buffer.alloc(0)
  const content = typeof file.content === 'string' ? file.content : ''
  return Buffer.from(content, file.encoding === entryEncoding.base64 ? 'base64' : 'utf8')
}

export async function bufferFromCloudFileEntry(file, cloudService = null, context = {}) {
  if (file.kind && file.kind !== entryKind.file) return Buffer.alloc(0)
  if (!isObjectStoredFileEntry(file)) return bufferFromFileEntry(file)
  if (!cloudService?.readBlob) {
    throw new Error(`Cannot read object-backed file without a configured blob store: ${file.blobKey ?? file.hash ?? '(missing key)'}`)
  }

  const buffer = await cloudService.readBlob(file, context)
  const actualHash = hashBuffer(buffer)
  const expectedHash = file.hash
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`object_blob_plaintext_hash_mismatch: expected ${expectedHash}, got ${actualHash}`)
  }
  if (Number.isInteger(file.size) && buffer.byteLength !== file.size) {
    throw new Error(`object_blob_plaintext_size_mismatch: expected ${file.size}, got ${buffer.byteLength}`)
  }
  return buffer
}

export async function cloudFileTextForVerification(file, cloudService = null) {
  if (!file) return ''
  const entry = normalizeCloudFileEntry('', file)
  return (await bufferFromCloudFileEntry(entry, cloudService)).toString('utf8')
}

export function isObjectStoredFileEntry(file) {
  return file?.kind === entryKind.file && file.contentStorage === contentStorageMode.objectBlob
}

export function normalizeContentStorageMode(value) {
  if (value === contentStorageMode.objectBlob) return contentStorageMode.objectBlob
  return contentStorageMode.inline
}

export function cloudEntryContentBytes(relativePath, file) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  if (entry.kind === entryKind.file) return entry.contentStorage === contentStorageMode.objectBlob ? entry.size : bufferFromFileEntry(entry).byteLength
  if (entry.kind === entryKind.symlink) return Buffer.byteLength(entry.target ?? '')
  return 0
}

export function cloudEntryEncodedBytes(relativePath, file) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  if (entry.kind === entryKind.file) return entry.contentStorage === contentStorageMode.objectBlob ? entry.size : Buffer.byteLength(entry.content ?? '')
  if (entry.kind === entryKind.symlink) return Buffer.byteLength(entry.target ?? '')
  return 0
}

export function cloudEntryEquals(a, b) {
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    a.size === b.size &&
    a.scope === b.scope &&
    (a.privacyZone ?? null) === (b.privacyZone ?? null) &&
    (a.target ?? null) === (b.target ?? null)
  )
}

export function toCloudPath(value) {
  return value.split(path.sep).join('/')
}
