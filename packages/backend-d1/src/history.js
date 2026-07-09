import { createHash } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'

export function buildFileVersionRows({ beforeGraph = null, afterGraph, createdAt = new Date().toISOString(), actor = {} }) {
  const codebaseId = afterGraph?.codebase?.id ?? beforeGraph?.codebase?.id ?? 'hopit'
  const beforeFiles = beforeGraph?.files ?? {}
  const afterFiles = afterGraph?.files ?? {}
  const paths = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].sort()
  const rows = []

  for (const filePath of paths) {
    const row = buildFileVersionRowForEntry({
      beforeGraph,
      afterGraph,
      path: filePath,
      beforeFile: beforeFiles[filePath] ?? null,
      afterFile: afterFiles[filePath] ?? null,
      createdAt,
      actor,
    })
    if (row) rows.push(row)
  }

  return rows
}

export function buildFileVersionRowForEntry({
  beforeGraph = null,
  afterGraph,
  entry = null,
  path = entry?.path,
  beforeFile = null,
  afterFile = null,
  createdAt = new Date().toISOString(),
  actor = {},
}) {
  const filePath = path
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const oldFile = beforeFile ?? null
  const newFile = afterFile ?? null
  if (oldFile && newFile && fileVersionEquivalent(oldFile, newFile)) return null
  if (!oldFile && !newFile) return null

  const codebaseId = afterGraph?.codebase?.id ?? beforeGraph?.codebase?.id ?? 'hopit'
  const revision = integerOrNull(newFile?.revision) ?? integerOrNull(afterGraph?.revision) ?? integerOrNull(oldFile?.revision) ?? 0
  const newDescriptor = newFile ? versionFileDescriptor(codebaseId, filePath, newFile) : null
  const oldDescriptor = oldFile ? versionFileDescriptor(codebaseId, filePath, oldFile) : null
  return {
    codebaseId,
    selectedStateType: afterGraph?.selectedState?.type ?? null,
    selectedStateId: afterGraph?.selectedState?.id ?? null,
    mainStateId: afterGraph?.main?.id ?? null,
    graphRevision: revision,
    path: filePath,
    operation: oldFile ? (newFile ? 'modify' : 'delete') : 'add',
    kind: newFile?.kind ?? oldFile?.kind ?? entry?.kind ?? 'file',
    oldRevision: integerOrNull(oldFile?.revision),
    newRevision: integerOrNull(newFile?.revision),
    oldFile: oldDescriptor,
    newFile: newDescriptor,
    scope: newDescriptor?.scope ?? oldDescriptor?.scope ?? scopeForPath(filePath),
    privacyZone: newDescriptor?.privacyZone ?? oldDescriptor?.privacyZone ?? privacyZoneForPath(filePath),
    zoneId: newDescriptor?.zoneId ?? oldDescriptor?.zoneId ?? privacyZoneIdForPath(codebaseId, filePath),
    contentStorage: newDescriptor?.contentStorage ?? oldDescriptor?.contentStorage ?? 'inline',
    blobProvider: newDescriptor?.blobProvider ?? oldDescriptor?.blobProvider ?? null,
    blobKey: newDescriptor?.blobKey ?? oldDescriptor?.blobKey ?? null,
    blobHash: newDescriptor?.blobHash ?? oldDescriptor?.blobHash ?? null,
    encoding: newDescriptor?.encoding ?? oldDescriptor?.encoding ?? 'utf8',
    target: newDescriptor?.target ?? oldDescriptor?.target ?? null,
    size: newDescriptor?.size ?? oldDescriptor?.size ?? null,
    actorUserId: actor.actorUserId ?? actor.userId ?? actor.requesterId ?? null,
    sessionId: actor.sessionId ?? afterGraph?.session?.id ?? null,
    deviceName: actor.deviceName ?? afterGraph?.session?.deviceName ?? null,
    createdAt,
  }
}

export function versionFileDescriptor(codebaseId, filePath, file) {
  if (!file || typeof file !== 'object') return null
  return {
    kind: file.kind ?? 'file',
    content: typeof file.content === 'string' ? file.content : '',
    encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
    target: file.target ?? null,
    hash: file.hash ?? file.blobHash ?? null,
    size: integerOrNull(file.size),
    scope: file.scope ?? scopeForPath(filePath),
    privacyZone: file.privacyZone ?? privacyZoneForPath(filePath),
    zoneId: file.zoneId ?? privacyZoneIdForPath(codebaseId, filePath),
    contentStorage: file.contentStorage === 'object-blob' ? 'object-blob' : 'inline',
    blobProvider: file.blobProvider ?? null,
    blobKey: file.blobKey ?? null,
    blobHash: file.blobHash ?? file.hash ?? null,
    blobSize: integerOrNull(file.blobSize),
    clientEncryption: file.clientEncryption ?? null,
    encryption: file.encryption ?? null,
    revision: integerOrNull(file.revision),
    updatedAt: file.updatedAt ?? null,
  }
}

export function retainedBlobKeysForVersions(versions = []) {
  const keys = new Set()
  for (const version of versions) {
    addBlobKey(keys, version?.oldFile)
    addBlobKey(keys, version?.newFile)
  }
  return keys
}

export function compareVersionRows(versions, leftRevision, rightRevision, options = {}) {
  const left = normalizeRevision(leftRevision)
  const right = normalizeRevision(rightRevision)
  const ordered = [...(versions ?? [])]
    .map(normalizeVersionRow)
    .filter(Boolean)
    .sort((a, b) => a.graphRevision - b.graphRevision || a.versionId - b.versionId || a.path.localeCompare(b.path))
  const bounds = revisionBounds(ordered)
  if (!Number.isInteger(left) || !Number.isInteger(right)) {
    return revisionExpired(leftRevision, rightRevision, bounds)
  }
  if (!bounds || left < bounds.min || right < bounds.min || left > bounds.max || right > bounds.max) {
    return revisionExpired(left, right, bounds)
  }

  const canSeePath = typeof options.canSeePath === 'function' ? options.canSeePath : () => true
  const leftFiles = visibleSnapshot(snapshotAtRevision(ordered, left), canSeePath)
  const rightFiles = visibleSnapshot(snapshotAtRevision(ordered, right), canSeePath)
  const paths = [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort()
  const entries = []
  const summary = {
    added: 0,
    modified: 0,
    deleted: 0,
    unchanged: 0,
    missingBlob: 0,
    integrityFailures: 0,
    requiresLocalKey: 0,
    binaryChanged: 0,
  }

  for (const filePath of paths) {
    const leftFile = leftFiles.get(filePath) ?? null
    const rightFile = rightFiles.get(filePath) ?? null
    const baseState = compareFileState(leftFile, rightFile)
    const state = decoratedFileState(baseState, leftFile, rightFile)
    const entry = {
      path: filePath,
      state,
      kind: rightFile?.kind ?? leftFile?.kind ?? 'file',
      scope: rightFile?.scope ?? leftFile?.scope ?? scopeForPath(filePath),
      privacyZone: rightFile?.privacyZone ?? leftFile?.privacyZone ?? privacyZoneForPath(filePath),
      left: summarizeVersionFile(leftFile),
      right: summarizeVersionFile(rightFile),
    }
    Object.defineProperty(entry, '_leftFile', { value: leftFile, enumerable: false })
    Object.defineProperty(entry, '_rightFile', { value: rightFile, enumerable: false })
    if (state === 'added') summary.added += 1
    else if (state === 'deleted') summary.deleted += 1
    else if (state === 'unchanged') summary.unchanged += 1
    else summary.modified += 1
    if (state === 'binary_changed') summary.binaryChanged += 1
    if (state === 'requiresLocalKey') summary.requiresLocalKey += 1
    entries.push(entry)
  }

  return {
    ok: true,
    leftRevision: left,
    rightRevision: right,
    retention: bounds,
    summary,
    entries,
    bodyFetches: 0,
    blobCacheHits: 0,
  }
}

export async function attachTextDiff(result, filePath, readFileBody) {
  if (!result?.ok || !filePath) return result
  const entry = result.entries.find((candidate) => candidate.path === filePath)
  if (!entry) return result
  const leftFile = entry._leftFile ?? entry.left
  const rightFile = entry._rightFile ?? entry.right
  if (entry.kind !== 'file') {
    entry.body = { state: 'metadata_only', reason: entry.kind }
    return result
  }
  if (isEncrypted(leftFile) || isEncrypted(rightFile)) {
    entry.state = 'requiresLocalKey'
    entry.body = { state: 'requiresLocalKey' }
    result.summary.requiresLocalKey += 1
    return result
  }
  if (isBinary(leftFile) || isBinary(rightFile)) {
    if (entry.state !== 'unchanged') {
      entry.state = 'binary_changed'
    }
    entry.body = {
      state: entry.state === 'unchanged' ? 'binary_unchanged' : 'binary_changed',
      left: binaryMetadata(leftFile),
      right: binaryMetadata(rightFile),
    }
    return result
  }

  const leftBody = leftFile ? await readFileBody(leftFile) : { ok: true, buffer: Buffer.alloc(0) }
  const rightBody = rightFile ? await readFileBody(rightFile) : { ok: true, buffer: Buffer.alloc(0) }
  if (!leftBody.ok || !rightBody.ok) {
    const failure = !leftBody.ok ? leftBody : rightBody
    entry.state = failure.state
    entry.body = failure
    if (failure.state === 'missing_blob') result.summary.missingBlob += 1
    if (failure.state === 'integrity_failure') result.summary.integrityFailures += 1
    return result
  }

  entry.body = {
    state: 'text_diff',
    diff: textDiffSummary(leftBody.buffer.toString('utf8'), rightBody.buffer.toString('utf8')),
  }
  return result
}

export function createCompareBlobReader({ readBlob, readInlineBlob, hash = sha256Hex } = {}) {
  const cache = new Map()
  const stats = { fetches: 0, cacheHits: 0 }

  async function readFileBody(file) {
    if (!file) return { ok: true, buffer: Buffer.alloc(0) }
    const cacheKey = file.blobKey ?? file.blobHash ?? file.hash ?? `${file.path}:${file.revision}`
    if (cache.has(cacheKey)) {
      stats.cacheHits += 1
      return cache.get(cacheKey)
    }

    let result
    try {
      if (file.contentStorage === 'object-blob') {
        stats.fetches += 1
        if (typeof readBlob === 'function') {
          result = { ok: true, buffer: Buffer.from(await readBlob(file)) }
        } else if (typeof readInlineBlob === 'function') {
          const inline = await readInlineBlob(file)
          result = inline ? { ok: true, buffer: Buffer.from(inline.content, inline.encoding === 'base64' ? 'base64' : 'utf8') } : { ok: false, state: 'missing_blob' }
        } else {
          result = { ok: false, state: 'missing_blob' }
        }
      } else {
        result = {
          ok: true,
          buffer: Buffer.from(file.content ?? '', file.encoding === 'base64' ? 'base64' : 'utf8'),
        }
      }
      if (result.ok && file.hash && hash(result.buffer) !== file.hash) {
        result = { ok: false, state: 'integrity_failure', expectedHash: file.hash, actualHash: hash(result.buffer) }
      }
    } catch (error) {
      result = missingBlobError(error)
    }

    cache.set(cacheKey, result)
    return result
  }

  return { readFileBody, stats }
}

export function normalizeVersionRow(row) {
  if (!row || typeof row !== 'object') return null
  const graphRevision = normalizeRevision(row.graphRevision ?? row.graph_revision)
  const path = row.path
  if (!Number.isInteger(graphRevision) || typeof path !== 'string') return null
  const versionId = integerOrNull(row.versionId ?? row.version_id) ?? 0
  return {
    versionId,
    codebaseId: row.codebaseId ?? row.codebase_id ?? null,
    graphRevision,
    path,
    operation: row.operation ?? 'modify',
    oldFile: row.oldFile ?? jsonOrNull(row.old_file_json),
    newFile: row.newFile ?? jsonOrNull(row.new_file_json),
    createdAt: row.createdAt ?? row.created_at ?? null,
  }
}

export function summarizeVersionFile(file) {
  if (!file) return null
  return {
    kind: file.kind ?? 'file',
    revision: integerOrNull(file.revision),
    hash: file.hash ?? null,
    size: integerOrNull(file.size),
    scope: file.scope ?? null,
    privacyZone: file.privacyZone ?? null,
    contentStorage: file.contentStorage ?? 'inline',
    blobProvider: file.blobProvider ?? null,
    blobKey: file.blobKey ?? null,
    blobHash: file.blobHash ?? null,
    blobSize: integerOrNull(file.blobSize),
    encoding: file.encoding ?? 'utf8',
    clientEncryption: file.clientEncryption ?? null,
  }
}

function snapshotAtRevision(versions, revision) {
  const files = new Map()
  for (const version of versions) {
    if (version.graphRevision > revision) break
    if (version.newFile) files.set(version.path, { path: version.path, ...version.newFile })
    else files.delete(version.path)
  }
  return files
}

function visibleSnapshot(files, canSeePath) {
  const visible = new Map()
  for (const [filePath, file] of files.entries()) {
    if (canSeePath(filePath, file)) visible.set(filePath, file)
  }
  return visible
}

function revisionBounds(versions) {
  if (!versions.length) return null
  return {
    min: versions[0].graphRevision,
    max: versions[versions.length - 1].graphRevision,
    retainedVersions: versions.length,
  }
}

function revisionExpired(leftRevision, rightRevision, bounds) {
  return {
    ok: false,
    error: {
      code: 'revision_expired',
      message: `Revision ${leftRevision} or ${rightRevision} is outside retained file-version history.`,
    },
    retention: bounds,
    summary: null,
    entries: [],
  }
}

function compareFileState(leftFile, rightFile) {
  if (!leftFile && rightFile) return 'added'
  if (leftFile && !rightFile) return 'deleted'
  if (!leftFile && !rightFile) return 'unchanged'
  return fileVersionEquivalent(leftFile, rightFile) ? 'unchanged' : 'modified'
}

function decoratedFileState(state, leftFile, rightFile) {
  if (state === 'modified' && (isEncrypted(leftFile) || isEncrypted(rightFile))) return 'requiresLocalKey'
  if (state === 'modified' && (isBinary(leftFile) || isBinary(rightFile))) return 'binary_changed'
  return state
}

function fileVersionEquivalent(left, right) {
  return stableFileSignature(left) === stableFileSignature(right)
}

function stableFileSignature(file) {
  return JSON.stringify({
    kind: file?.kind ?? 'file',
    content: file?.content ?? '',
    encoding: file?.encoding ?? 'utf8',
    target: file?.target ?? null,
    hash: file?.hash ?? null,
    size: integerOrNull(file?.size),
    contentStorage: file?.contentStorage ?? 'inline',
    blobProvider: file?.blobProvider ?? null,
    blobKey: file?.blobKey ?? null,
    blobHash: file?.blobHash ?? null,
    blobSize: integerOrNull(file?.blobSize),
    clientEncryption: file?.clientEncryption ?? null,
  })
}

function textDiffSummary(leftText, rightText) {
  const leftLines = splitLines(leftText)
  const rightLines = splitLines(rightText)
  let prefix = 0
  while (prefix < leftLines.length && prefix < rightLines.length && leftLines[prefix] === rightLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix + prefix < leftLines.length &&
    suffix + prefix < rightLines.length &&
    leftLines[leftLines.length - 1 - suffix] === rightLines[rightLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = leftLines.slice(prefix, leftLines.length - suffix)
  const added = rightLines.slice(prefix, rightLines.length - suffix)
  return {
    changed: leftText !== rightText,
    leftLineCount: leftLines.length,
    rightLineCount: rightLines.length,
    commonPrefixLines: prefix,
    commonSuffixLines: suffix,
    addedLines: added,
    removedLines: removed,
    addedLineCount: added.length,
    removedLineCount: removed.length,
  }
}

function splitLines(text) {
  if (!text) return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

function isBinary(file) {
  return file?.encoding === 'base64'
}

function isEncrypted(file) {
  return file?.clientEncryption?.state === 'client-encrypted' || file?.encryption?.state === 'client-encrypted'
}

function binaryMetadata(file) {
  return file
    ? {
        hash: file.hash ?? null,
        size: integerOrNull(file.size),
        blobHash: file.blobHash ?? null,
        blobSize: integerOrNull(file.blobSize),
      }
    : null
}

function missingBlobError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/hash_mismatch|integrity|plaintext_hash_mismatch/i.test(message)) {
    return { ok: false, state: 'integrity_failure', message }
  }
  return { ok: false, state: 'missing_blob', message }
}

function addBlobKey(keys, file) {
  if (file?.contentStorage === 'object-blob' && typeof file.blobKey === 'string' && file.blobKey) {
    keys.add(file.blobKey)
  }
}

function normalizeRevision(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isSafeInteger(parsed) ? parsed : null
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null
}

function jsonOrNull(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
