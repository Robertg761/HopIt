// @ts-check
// GR-A3 (decisions §1: divergence surfaces). `hop conflicts` lists open
// same-owner multi-device divergences classified by GR-A1's reconnect engine
// and lets the owner resolve them from the terminal. No automatic line-level
// merge ever happens here: `--keep local` and `--keep cloud` are the only two
// resolutions, and a user who manually combined both sides into the local
// file before running `--keep local` is exactly how "combined" resolutions
// happen -- there is no separate flag for it.
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { entryKind } from '../constants.js'
import { privacyZoneForPath } from '@hopit/core/crypto'
import { appendNdjson, emit, readNdjson } from '../io.js'
import { journalContextForCloud, normalizeCloudFileEntry } from '../journal.js'
import { assertWorkspacePathSafe } from '../paths.js'
import { deriveOpenDivergences } from '../reconnect.js'
import { reportResult } from '../output.js'
import { materializeCloudEntry } from './sync.js'
import { classifyJournalEntries } from '../status-state.js'
import { readSingleWorkspaceEntry, workspaceFilePath } from '../workspace-manifest.js'
import { scopeForPath } from '@hopit/core/privacy-zone'

export async function runConflictsCommand(action = 'list', pathArg = null, options = {}) {
  switch (action) {
    case 'list':
      return runConflictsList(options)
    case 'resolve':
      return runConflictsResolve(pathArg ?? options.path ?? null, options)
    default:
      throw new Error(`Unknown conflicts command: ${action}. Try: hop conflicts | hop conflicts resolve <path> --keep local|cloud`)
  }
}

export async function listOpenDivergences(options) {
  const eventEntries = await readNdjson(options.events)
  return deriveOpenDivergences(eventEntries)
}

async function runConflictsList(options) {
  const divergences = await listOpenDivergences(options)
  const result = { ok: true, count: divergences.length, divergences }

  reportResult(options, result, ({ line, accent, muted, caution }) => {
    if (divergences.length === 0) {
      line(`  ${accent('✓')} No open divergences.`)
      return
    }
    line(`  ${caution('!')} ${divergences.length} open divergence${divergences.length === 1 ? '' : 's'}`)
    for (const divergence of divergences) {
      const ageSeconds = divergence.ageMs === null ? null : Math.round(divergence.ageMs / 1000)
      const localLabel = divergence.localDeviceName ?? 'this device'
      const cloudLabel = divergence.cloudDeviceName ?? 'cloud'
      line(
        `    ${muted('•')} ${divergence.path} ${muted(`(${localLabel} vs ${cloudLabel}${ageSeconds === null ? '' : `, ${ageSeconds}s ago`})`)}`,
      )
    }
  })
  return result
}

async function runConflictsResolve(targetPath, options) {
  if (!targetPath) {
    throw new Error('Usage: hop conflicts resolve <path> --keep local|cloud')
  }
  const keep = options.keep
  if (keep !== 'local' && keep !== 'cloud') {
    throw new Error('Usage: hop conflicts resolve <path> --keep local|cloud')
  }

  await assertWorkspacePathSafe(options)

  const divergences = await listOpenDivergences(options)
  const divergence = divergences.find((entry) => entry.path === targetPath)
  if (!divergence) {
    throw new Error(`No open divergence for path: ${targetPath}`)
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()

  const result = keep === 'cloud'
    ? await resolveKeepCloud(options, cloudService, cloud, targetPath, divergence)
    : await resolveKeepLocal(options, cloudService, cloud, targetPath, divergence)

  // The pending journal entries that caused this divergence are superseded
  // by this resolution either way: on `--keep cloud` the local edit is
  // discarded, and on `--keep local` a fresh entry (above) already carries
  // the resolved content forward. Leaving the old entries pending would
  // reopen the same divergence the next time `hop recover` runs.
  await acknowledgeStalePendingEntriesForPath(options, targetPath)

  reportResult(options, result, ({ line, success }) => {
    line(`  ${success('✓')} Resolved ${targetPath}: kept ${keep}${result.combined ? ' (combined)' : ''}`)
  })
  return result
}

async function resolveKeepCloud(options, cloudService, cloud, targetPath, divergence) {
  const absolutePath = workspaceFilePath(options.workspace, targetPath)
  const cloudFile = cloud.files?.[targetPath] ? normalizeCloudFileEntry(targetPath, cloud.files[targetPath]) : null

  if (!cloudFile) {
    await fs.rm(absolutePath, { recursive: true, force: true })
  } else {
    await materializeCloudEntry(options.workspace, targetPath, cloudFile, cloudService)
  }

  await emit(options, 'conflicts.resolved', {
    path: targetPath,
    keep: 'cloud',
    reason: divergence.reason,
    localHash: divergence.localHash,
    cloudHash: divergence.cloudHash,
    localDeviceName: divergence.localDeviceName,
    cloudDeviceName: divergence.cloudDeviceName,
    revision: cloud.revision,
  })

  return { ok: true, path: targetPath, keep: 'cloud', combined: false, revision: cloud.revision }
}

async function resolveKeepLocal(options, cloudService, cloud, targetPath, divergence) {
  if (!existsSync(options.workspace)) throw new Error('workspace_missing')

  const absolutePath = workspaceFilePath(options.workspace, targetPath)
  const now = new Date().toISOString()
  const scope = scopeForPath(targetPath)

  if (!existsSync(absolutePath)) {
    // The offline device's resolution is "delete": replay the delete against
    // whatever the cloud head is right now (rebased, not the stale base that
    // caused the divergence in the first place).
    const entry = {
      id: randomUUID(),
      type: 'delete',
      path: targetPath,
      kind: cloud.files?.[targetPath]?.kind ?? entryKind.file,
      scope,
      privacyZone: privacyZoneForPath(targetPath),
      baseRevision: cloud.files?.[targetPath]?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(cloud),
    }
    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)
    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, { now })
    await emit(options, 'cloud.acknowledged', acknowledgement)
    if (!cloudService.usesAtomicFileMutations) await cloudService.writeGraph(cloud)

    await emit(options, 'conflicts.resolved', {
      path: targetPath,
      keep: 'local',
      reason: divergence.reason,
      resolvedAs: 'delete',
      revision: cloud.revision,
    })
    return { ok: true, path: targetPath, keep: 'local', combined: false, revision: cloud.revision }
  }

  const diskEntry = normalizeCloudFileEntry(targetPath, await readSingleWorkspaceEntry(options.workspace, targetPath))
  const current = cloud.files?.[targetPath] ? normalizeCloudFileEntry(targetPath, cloud.files[targetPath]) : null
  const entry = {
    id: randomUUID(),
    type: current ? 'write' : 'create',
    path: targetPath,
    kind: diskEntry.kind,
    scope,
    privacyZone: privacyZoneForPath(targetPath),
    hash: diskEntry.hash,
    bytes: diskEntry.size,
    encoding: diskEntry.encoding,
    target: diskEntry.target ?? null,
    // Rebased onto the current cloud head, not the stale base that caused the
    // divergence -- this is a resolution step, not a replay of the original
    // conflicting write.
    baseRevision: current?.revision ?? null,
    createdAt: now,
    status: 'pending',
    ...journalContextForCloud(cloud),
  }
  await appendNdjson(options.journal, entry)
  await emit(options, 'write.journaled', entry)
  const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, { entry: diskEntry, now })
  await emit(options, 'cloud.acknowledged', acknowledgement)
  if (!cloudService.usesAtomicFileMutations) await cloudService.writeGraph(cloud)

  // A user who resolved by hand-editing the local file to combine both sides
  // (decisions §1: no automatic line-level merge, so this is the only way a
  // "combined" resolution happens) shows up here as content that no longer
  // matches the local diverged edit that was originally recorded.
  const combined = Boolean(divergence.localHash) && diskEntry.hash !== divergence.localHash

  await emit(options, 'conflicts.resolved', {
    path: targetPath,
    keep: 'local',
    reason: divergence.reason,
    combined,
    revision: cloud.revision,
  })

  return { ok: true, path: targetPath, keep: 'local', combined, revision: cloud.revision }
}

async function acknowledgeStalePendingEntriesForPath(options, targetPath) {
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const stalePending = journalState.entries.filter(
    (entry) => entry.path === targetPath && entry.recoveryStatus === 'pending',
  )

  for (const entry of stalePending) {
    await emit(options, 'cloud.acknowledged', {
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      recovered: false,
      resolution: 'conflict_resolved',
    })
  }

  return stalePending.length
}
