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
  // GR-G1 (decisions §11): idle dehydration is default-on so a codebase does
  // not permanently occupy device disk just because nobody opted in. Explicit
  // `--no-auto-prune` (or HOPIT_AUTO_PRUNE=0) still disables it per invocation.
  'auto-prune': true,
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
// Periodic full workspace diff-scan (decisions doc §12: "missed watcher events
// are assumed, not exceptional"). Runs independent of both the fs watcher and
// the 5-min cloud graph-head reconciliation, so a dropped FSEvents/inotify
// notification still heals within one scan interval. Conservative default
// (10 min) because the scan walks the entire workspace tree every tick;
// --scan-interval-ms / HOPIT_SCAN_INTERVAL_MS tune it per install.
export const defaultWorkspaceScanIntervalMs = 10 * 60 * 1000
export const minimumWorkspaceScanIntervalMs = 1000
// When the native watcher can't run at all because the OS watch limit
// (Linux inotify's fs.inotify.max_user_watches) is exhausted, the agent falls
// back to scan-based syncing (GR-H2). That fallback needs to poll noticeably
// tighter than a routine health-check scan since it is the *only* signal for
// missed writes while degraded, hence a smaller default than the generic
// watcher-failure poll cadence would otherwise need.
export const defaultWatchLimitPollIntervalMs = 2000
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
// Large files sync like everything else (decisions doc §11: no cap, no gate) --
// this is purely a dashboard/notification threshold so storage surprises are
// visible. Adjustable per codebase via codebase_settings.large_file_threshold_bytes;
// null/unset falls back to this default.
export const defaultLargeFileThresholdBytes = 100 * 1024 * 1024

// GR-G1 (decisions §11): disk-pressure acceleration for idle dehydration.
// When the workspace's device drops below either the absolute free-bytes
// floor or the free-fraction floor, the auto-prune scheduler shortens the
// idle-eviction window by accelerationFactor so a nearly-full disk sheds
// cached (already-synced) content faster instead of quietly filling up.
// This only ever accelerates *content* eviction: the journal itself is never
// an eviction candidate (see pruneWorkspaceCache's journal-path guard), and
// unacknowledged journal writes are never evicted regardless of pressure.
export const defaultDiskPressureFreeBytesThreshold = 5 * 1024 * 1024 * 1024
export const defaultDiskPressureFreeFraction = 0.1
export const diskPressureAccelerationFactor = 0.25

// Derived/generated paths (decisions §6): local-only, never watched-through,
// never journaled, never synced, never counted in presence, and distinct from
// both `.private/` (owner-private but still synced) and an ignore file (there
// is no config file in the repo). Each entry is either a bare directory name
// (matches that segment anywhere in the relative path, e.g. any nested
// `node_modules/`) or a `/`-joined relative prefix (matches only that exact
// subtree, e.g. `vendor/bundle` does not derive a plain top-level `vendor/`).
// Curated list; extend here as ecosystems are added. Per-codebase user
// overrides live in `codebase_settings.derived_path_overrides`, layered on
// top of this list at classification time (see `isDerivedWorkspacePath` in
// workspace-manifest.js) rather than mutating it.
export const curatedDerivedPathRules = [
  'node_modules',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.turbo',
  '.gradle',
  'vendor/bundle',
  // Carried over from the pre-classification `generatedWorkspaceDirectories`
  // guard (2026-07-08 node_modules flood fix).
  '.vercel',
  'out',
  'coverage',
  'artifacts',
  'DerivedData',
]

export class ConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}
