/**
 * Client-facing shapes for the WS7c-backed compare surface. These mirror the
 * `/api/codebases/compare` route envelopes. The route is a thin wrapper over the
 * backend `compareRevisions` engine, so these types describe its output. We
 * never invent fields the engine does not produce.
 */

export type CompareFileSummary = {
  kind?: string | null
  revision?: number | null
  hash?: string | null
  size?: number | null
  scope?: string | null
  privacyZone?: string | null
  contentStorage?: string | null
  blobProvider?: string | null
  blobKey?: string | null
  blobHash?: string | null
  blobSize?: number | null
  encoding?: string | null
  clientEncryption?: unknown
}

export type CompareFileState =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'unchanged'
  | 'binary_changed'
  | 'requiresLocalKey'
  | 'missing_blob'
  | 'integrity_failure'

export type CompareEntry = {
  path: string
  state: string
  kind: string
  scope: string
  privacyZone: string
  left: CompareFileSummary | null
  right: CompareFileSummary | null
  body?: CompareFileBody
}

export type TextDiffSummary = {
  changed: boolean
  leftLineCount: number
  rightLineCount: number
  commonPrefixLines: number
  commonSuffixLines: number
  addedLines: string[]
  removedLines: string[]
  addedLineCount: number
  removedLineCount: number
}

export type BinaryBodyMetadata = {
  hash?: string | null
  size?: number | null
  blobHash?: string | null
  blobSize?: number | null
} | null

export type CompareFileBody =
  | { state: 'text_diff'; diff: TextDiffSummary }
  | { state: 'binary_changed' | 'binary_unchanged'; left: BinaryBodyMetadata; right: BinaryBodyMetadata }
  | { state: 'requiresLocalKey' }
  | { state: 'metadata_only'; reason: string }
  | { state: 'missing_blob'; message?: string }
  | { state: 'integrity_failure'; message?: string; expectedHash?: string; actualHash?: string }

export type CompareSummary = {
  added: number
  modified: number
  deleted: number
  unchanged: number
  missingBlob: number
  integrityFailures: number
  requiresLocalKey: number
  binaryChanged: number
}

export type CompareRetention = {
  min: number
  max: number
  retainedVersions: number
}

export type CompareError = {
  code: string
  message: string
}

export type RevisionsResponse = {
  ok: boolean
  codebaseId: string | null
  mode?: 'revisions'
  revisions: number[]
  retention: CompareRetention | null
  error?: CompareError
}

export type DirectoryCompareResponse = {
  ok: boolean
  codebaseId: string | null
  mode?: 'directory'
  leftRevision?: number
  rightRevision?: number
  retention?: CompareRetention | null
  summary?: CompareSummary | null
  entries?: CompareEntry[]
  error?: CompareError
}

export type FileDiffResponse = {
  ok: boolean
  codebaseId: string | null
  mode?: 'file'
  leftRevision?: number
  rightRevision?: number
  path?: string
  entry?: CompareEntry
  bodyFetches?: number
  blobCacheHits?: number
  error?: CompareError
}
