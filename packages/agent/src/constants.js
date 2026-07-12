// @ts-check
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const __filename = fileURLToPath(import.meta.url)
export const __dirname = path.dirname(__filename)
export const fixturePath = path.resolve(__dirname, '../fixtures/demo-cloud.json')

export const defaultOptions = {
  cloud: '.hopit-agent/cloud.json',
  workspace: '.hopit-agent/workspaces/hopit-core',
  journal: '.hopit-agent/journal.ndjson',
  events: '.hopit-agent/events.ndjson',
  pid: '.hopit-agent/hopit.pid',
  host: '127.0.0.1',
  port: '4785',
}

export const workspaceMode = {
  adapter: 'managed-folder',
  cacheMode: 'local-cache',
  sourceOfTruth: 'cloud',
  materializationPolicy: 'metadata-first',
  hydrationPolicy: 'explicit-refresh-or-file',
  remoteUpdatePolicy: 'materialized-clean-only',
}

export const workspaceIndexVersion = 1
export const localCacheSchemaVersion = 1
export const cloudServiceType = 'fixture-json-cloud-graph'

export const fileScope = {
  shared: 'shared',
  ownerPrivate: 'owner-private',
}

export const entryKind = {
  file: 'file',
  symlink: 'symlink',
  directory: 'directory',
}

export const entryEncoding = {
  utf8: 'utf8',
  base64: 'base64',
}

export const contentStorageMode = {
  inline: 'inline',
  objectBlob: 'object-blob',
}

export const objectBlobProvider = {
  filesystem: 'filesystem',
  r2: 'r2',
  s3: 's3',
  b2: 'b2',
}

export const defaultFileStorageBudgetBytes = 1_000_000_000
export const defaultOpenHydrationMaxFiles = 64
export const defaultOpenHydrationMaxBytes = 1_048_576
export const defaultOpenHydrationSmallFileBytes = 64_000
export const defaultSiblingHydrationMaxFiles = 8
export const defaultSiblingHydrationMaxBytes = 128_000
// Any commit of 2+ journal entries is batched into a single guarded D1 round
// trip (one codebases head-row write + one files/file_versions row per path)
// instead of one round trip and one head-row write per file. A coalesced
// multi-file save therefore writes one head row, not N. Single-file commits stay
// on the direct path (no bulk-commit summary event, identical row count).
export const bulkJournalCommitThreshold = 1
export const bulkJournalCommitChunkSize = 40
// Watch-loop save coalescing. Rapid successive saves of the same path collapse
// into a single journaled write carrying the final content, so a keystroke-heavy
// editing session commits far fewer cloud revisions (each revision fans out into
// codebases + files + file_versions + agent_events D1 row writes at $1.00/M).
//   - defaultSyncDebounceMs: quiet-window before a coalesced sync flushes.
//   - defaultSyncMaxDelayMs: hard cap on how long the first unsynced change may
//     be held, so the invisible-sync promise (seconds, not minutes) still holds
//     while someone types continuously.
//   - legacySyncDebounceMs: the pre-coalescing micro-debounce; HOPIT_SYNC_DEBOUNCE_MS=0
//     restores exactly this behavior (no coalescing, no delay cap).
export const defaultSyncDebounceMs = 2000
export const defaultSyncMaxDelayMs = 5000
export const legacySyncDebounceMs = 250
// Refresh deletion safety: refresh materialization deletes every workspace file
// absent from the visible cloud graph. A visibility misconfiguration (session id
// without a requester id reads the cloud as a guest and sees zero files) can turn
// a refresh into a full-workspace wipe. Fail closed when the deletion looks like a
// mass wipe rather than a legitimate small drop.
export const refreshMassDeleteMinFiles = 100
export const refreshMassDeleteFraction = 0.5
export const r2FreeStorageTierBytes = 10_000_000_000
export const r2DefaultFreeOnlyBudgetBytes = 8_000_000_000
export const serviceReadyTimeoutMs = 60_000
export const serviceStatusFetchTimeoutMs = 5_000
export const defaultMirrorSecretRoutes = new Map([
  ['.env.local', '.private/env/repo-root/.env.local'],
])
export const mirrorSecretFileNames = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
])
export const mirrorNonSecretEnvSuffixes = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'default',
])
export const defaultLaunchAgentLabelPrefix = 'com.hopit.agent'

export class ConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}
