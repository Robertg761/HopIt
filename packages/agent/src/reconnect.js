// @ts-check
// Reconnect classification engine (decisions §1: same-owner multi-device
// divergence). Before a reconnecting agent replays its journal it must sort
// pending edits per path into one of three buckets:
//
//   1. only-local-touched   -> replay cleanly onto the trail (the common case)
//   2. both-touched, same   -> auto-resolve as one step (no divergence)
//   3. both-touched, differ -> a real divergence: never replayed, never
//                              clobbers the local file
//
// "Both touched" is detected by comparing the journal entry's recorded
// baseRevision against the cloud file's current revision: if they differ,
// something else committed to that path after this device last saw it.
// Journals written before this classifier existed (or entries where the
// caller never recorded a baseRevision) fall back to "only-local", which
// keeps pre-existing recoverJournal behavior byte-identical on journals that
// carry no divergence signal at all.
import { normalizeCloudFileEntry } from './journal.js'
import { scopeForPath } from '@hopit/core/privacy-zone'

export const reconnectBucket = {
  onlyLocal: 'only-local',
  autoResolved: 'auto-resolved',
  diverged: 'diverged',
}

/**
 * Orders journal entries by causality (their recorded base revision), never
 * by wall-clock createdAt. Clock skew on a reconnecting device must never
 * change replay order. Entries without a known base revision carry no
 * causal signal and keep their original relative order (stable sort),
 * ordered after any entry that does carry one.
 */
export function sortEntriesByCausality(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aRevision = causalRevision(a.entry)
      const bRevision = causalRevision(b.entry)
      if (aRevision !== null && bRevision !== null && aRevision !== bRevision) {
        return aRevision - bRevision
      }
      if (aRevision !== null && bRevision === null) return -1
      if (aRevision === null && bRevision !== null) return 1
      return a.index - b.index
    })
    .map(({ entry }) => entry)
}

function causalRevision(entry) {
  return Number.isInteger(entry?.baseRevision) ? entry.baseRevision : null
}

/**
 * Classifies a single journal entry against the current cloud head.
 */
export function classifyReconnectEntry(cloud, entry) {
  const relativePath = entry.path
  const scope = entry.scope ?? scopeForPath(relativePath)
  const cloudFile = cloud?.files?.[relativePath]
    ? normalizeCloudFileEntry(relativePath, cloud.files[relativePath])
    : null
  const cloudRevision = cloudFile?.revision ?? null
  const baseRevisionKnown = Object.hasOwn(entry, 'baseRevision') && entry.baseRevision !== undefined
  const baseRevision = baseRevisionKnown ? entry.baseRevision : null
  const bothTouched = baseRevisionKnown && cloudRevision !== baseRevision

  const base = {
    path: relativePath,
    entry,
    scope,
    baseRevision,
    cloudRevision,
    cloudHash: cloudFile?.hash ?? null,
    localHash: entry.hash ?? null,
  }

  if (!bothTouched) {
    return { ...base, bucket: reconnectBucket.onlyLocal, reason: 'only_local_touched' }
  }

  if (entry.type === 'delete') {
    if (!cloudFile) {
      return { ...base, bucket: reconnectBucket.autoResolved, reason: 'both_deleted', localHash: null }
    }
    return {
      ...base,
      bucket: reconnectBucket.diverged,
      reason: 'delete_vs_edit',
      localHash: null,
      localSide: 'deleted',
    }
  }

  if (!cloudFile) {
    return {
      ...base,
      bucket: reconnectBucket.diverged,
      reason: 'edit_vs_delete',
      cloudSide: 'deleted',
    }
  }

  const sameContent = cloudFile.hash === entry.hash && cloudFile.kind === (entry.kind ?? cloudFile.kind)
  if (sameContent) {
    return { ...base, bucket: reconnectBucket.autoResolved, reason: 'identical_content' }
  }

  return { ...base, bucket: reconnectBucket.diverged, reason: 'content_differs' }
}

/**
 * Classifies a batch of pending journal entries into the three reconnect
 * buckets from decisions §1. Entries are grouped by path first (using the
 * causally-last entry per path as the device's intended final state for
 * that path), then classified against the cloud head.
 */
export function classifyReconnectEntries(cloud, entries) {
  const ordered = sortEntriesByCausality(entries)
  const lastEntryByPath = new Map()
  for (const entry of ordered) {
    if (!entry?.path) continue
    lastEntryByPath.set(entry.path, entry)
  }

  const classifications = []
  for (const entry of lastEntryByPath.values()) {
    classifications.push(classifyReconnectEntry(cloud, entry))
  }

  const byPath = new Map(classifications.map((classification) => [classification.path, classification]))
  const buckets = {
    [reconnectBucket.onlyLocal]: [],
    [reconnectBucket.autoResolved]: [],
    [reconnectBucket.diverged]: [],
  }
  for (const classification of classifications) {
    buckets[classification.bucket].push(classification)
  }

  return { classifications, byPath, buckets }
}

/**
 * Splits a batch of pending journal entries into the ones safe to replay
 * (buckets 1 and 2) and the ones that must not be replayed because they are
 * a genuine divergence (bucket 3). Every entry for a diverged path is
 * excluded from replay, not just its causally-last entry, so no partial
 * intermediate state for that path is ever committed. Replayable entries
 * are returned in causal order.
 *
 * Auto-resolved entries (bucket 2) carry a stale baseRevision by definition
 * -- the cloud head moved since this device last saw the path, which is
 * exactly why they were classified as "both touched". Since their content
 * already matches the cloud head, replaying them is a pure no-op, so their
 * baseRevision (and targetStateRevision, if present) is rewritten to the
 * cloud's current values before replay; this keeps the base/selected-state
 * revision guards (`assertEntryBaseRevision`, `assertEntrySelectedStateRevision`)
 * from rejecting a no-op as if it were a real conflict.
 */
export function partitionEntriesForReconnect(cloud, entries) {
  const { classifications, byPath } = classifyReconnectEntries(cloud, entries)
  const divergedPaths = new Set(
    classifications.filter((classification) => classification.bucket === reconnectBucket.diverged)
      .map((classification) => classification.path),
  )
  const diverged = classifications.filter((classification) => classification.bucket === reconnectBucket.diverged)
  const replayable = sortEntriesByCausality(entries)
    .filter((entry) => !entry.path || !divergedPaths.has(entry.path))
    .map((entry) => reconcileEntryForReplay(entry, byPath.get(entry.path), cloud))

  return { replayable, diverged, classifications }
}

/**
 * Builds the payload passed to a cloud service's `openDivergence` for one
 * diverged classification (decisions §1 / GR-A2). Pure and I/O-free: callers
 * resolve the local device's on-disk content (`localEntry`) and both
 * devices' labels before calling this, then persist the result. Nothing
 * about the offline device's version is discarded here -- `localEntry`
 * carries its full payload (or is `null` only when the local side genuinely
 * has no content, i.e. `delete_vs_edit`) so it stays independently
 * retrievable even though it is never written to `files` while open.
 */
export function buildDivergenceRecord(classification, { localEntry = null, localDevice = null, cloudDevice = null } = {}) {
  return {
    path: classification.path,
    scope: classification.scope,
    reason: classification.reason,
    baseRevision: classification.baseRevision,
    cloudRevision: classification.cloudRevision,
    localHash: classification.localHash,
    cloudHash: classification.cloudHash,
    localSide: classification.localSide ?? null,
    cloudSide: classification.cloudSide ?? null,
    localDevice,
    cloudDevice,
    localEntry: classification.localSide === 'deleted' ? null : localEntry,
  }
}

function reconcileEntryForReplay(entry, classification, cloud) {
  if (classification?.bucket !== reconnectBucket.autoResolved) return entry

  const reconciled = { ...entry, baseRevision: classification.cloudRevision }
  if (Object.hasOwn(entry, 'targetStateRevision') && entry.targetStateRevision !== undefined) {
    reconciled.targetStateRevision = cloud?.selectedState?.revision ?? entry.targetStateRevision
  }
  return reconciled
}

// GR-A3 (decisions §1: divergence surfaces). `recoverJournal` never persists
// its own durable divergence records (that is GR-A2's job); it does emit one
// `journal.reconnect_diverged` event per diverged path every time recovery
// runs against still-unresolved journal entries. This derives the current
// *open* set from the local event log alone -- the same event log `hop
// status`/`hop conflicts` already read -- by pairing each diverged path with
// the most recent `conflicts.resolved` event for that path: a divergence is
// open if it has never been resolved, or if it diverged again after its last
// resolution. Used by both the fast status endpoint (no live cloud read) and
// the full `hop status`/`hop conflicts` paths, so this must only depend on
// events.ndjson.
export function deriveOpenDivergences(eventEntries) {
  const latestDivergedByPath = new Map()
  const latestResolvedByPath = new Map()

  for (const event of eventEntries) {
    if (event?.event === 'journal.reconnect_diverged') {
      const detailPath = event.detail?.path
      if (!detailPath) continue
      latestDivergedByPath.set(detailPath, event)
    } else if (event?.event === 'conflicts.resolved') {
      const detailPath = event.detail?.path
      if (!detailPath) continue
      latestResolvedByPath.set(detailPath, event)
    }
  }

  const now = Date.now()
  const open = []
  for (const [path, divergedEvent] of latestDivergedByPath) {
    const resolvedEvent = latestResolvedByPath.get(path)
    if (resolvedEvent && !isEventBefore(resolvedEvent, divergedEvent)) continue

    const detail = divergedEvent.detail ?? {}
    const detectedAt = divergedEvent.at ?? null
    const detectedAtMs = detectedAt ? Date.parse(detectedAt) : Number.NaN
    open.push({
      path,
      scope: detail.scope ?? null,
      reason: detail.reason ?? null,
      entryId: detail.id ?? null,
      entryType: detail.type ?? null,
      baseRevision: Number.isInteger(detail.baseRevision) ? detail.baseRevision : null,
      cloudRevision: Number.isInteger(detail.cloudRevision) ? detail.cloudRevision : null,
      localHash: detail.localHash ?? null,
      cloudHash: detail.cloudHash ?? null,
      localDeviceName: detail.localDeviceName ?? null,
      cloudDeviceName: detail.cloudDeviceName ?? null,
      detectedAt,
      ageMs: Number.isNaN(detectedAtMs) ? null : Math.max(0, now - detectedAtMs),
    })
  }

  return open.sort((a, b) => a.path.localeCompare(b.path))
}

function isEventBefore(event, reference) {
  const eventAt = Date.parse(event?.at)
  const referenceAt = Date.parse(reference?.at)
  if (Number.isNaN(eventAt) || Number.isNaN(referenceAt)) return false
  return eventAt < referenceAt
}
