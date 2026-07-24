// @ts-check
// GR-F2 (decisions §10): save-side clobber detection.
//
// The agent cannot see unsaved editor buffers -- only disk -- so clobber
// protection has to be save-side: if a file was remote-refreshed since the
// user's last local save to that path, the next local save is a *candidate*
// clobber (a stale editor buffer being saved back over content Main already
// moved past). This module tracks, per path, which kind of write last
// touched it (a remote refresh vs a journaled local save) and classifies the
// next local save against that history, reusing GR-A1's reconnect
// classification buckets (`packages/agent/src/reconnect.js`) so "diverged"
// means exactly what it means at reconnect time: never replayed, never a
// silent revert of either side.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readJson, writeJson } from './io.js'
import { classifyReconnectEntry, reconnectBucket } from './reconnect.js'

export const writerLedgerSchemaVersion = 1

// Ledger lives next to the journal file it protects (same directory, same
// base name) so per-codebase journal paths (`journal/<codebaseId>.ndjson`)
// naturally get their own ledger without adding a new CLI option.
export function writerLedgerPathFor(options) {
  const journalPath = options.journal
  const dir = path.dirname(journalPath)
  const base = path.basename(journalPath, path.extname(journalPath))
  return path.join(dir, `${base}.writer-ledger.json`)
}

export function emptyWriterLedger() {
  return { schemaVersion: writerLedgerSchemaVersion, paths: {} }
}

export async function readWriterLedger(options) {
  const ledgerPath = writerLedgerPathFor(options)
  if (!existsSync(ledgerPath)) return emptyWriterLedger()
  try {
    const raw = await readJson(ledgerPath)
    return { schemaVersion: writerLedgerSchemaVersion, paths: raw?.paths && typeof raw.paths === 'object' ? raw.paths : {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyWriterLedger()
    throw error
  }
}

export async function writeWriterLedger(options, ledger) {
  const ledgerPath = writerLedgerPathFor(options)
  await writeJson(ledgerPath, { schemaVersion: writerLedgerSchemaVersion, paths: ledger.paths ?? {} })
}

// Marks that a remote refresh just materialized new content at `relativePath`.
// This is the only thing that opens a "pending refresh" for a path -- it is
// cleared only once a subsequent local save resolves it (clean or diverged).
export function markRefreshWriter(ledger, relativePath, { hash, revision = null }) {
  const record = ledger.paths[relativePath] ?? {}
  ledger.paths[relativePath] = {
    ...record,
    pendingRefresh: { hash, revision },
  }
  return ledger
}

// Marks that a local save was journaled cleanly at `relativePath`, recording
// the cloud revision it committed at as the new baseline the local editor is
// assumed to know, and clearing any pending refresh it resolved.
export function markLocalSaveWriter(ledger, relativePath, { revision = null }) {
  ledger.paths[relativePath] = {
    lastLocalSaveRevision: revision,
    pendingRefresh: null,
  }
  return ledger
}

export function clearWriterLedgerPath(ledger, relativePath) {
  delete ledger.paths[relativePath]
  return ledger
}

// Classifies a local save against the writer ledger for `relativePath`.
// Reuses `classifyReconnectEntry` verbatim: the pending refresh stands in for
// the cloud head, the local save stands in for a pending journal entry with
// its recorded base revision (the last local save this device knows it
// committed). Returns one of the GR-A1 buckets:
//   - only-local:    no pending refresh (or it was already resolved) -- an
//                     ordinary edit, safe to journal.
//   - auto-resolved:  the save is byte-identical to the refreshed content, or
//                     its content builds on (contains) the refreshed text --
//                     a clean edit, safe to journal.
//   - diverged:       neither -- a candidate stale-editor-buffer clobber.
//                     Must not be journaled; the caller must surface it
//                     instead of silently overwriting Main's version.
export function classifySaveAgainstRefresh({ ledger, relativePath, kind, newHash, newContent, refreshedContent }) {
  const record = ledger?.paths?.[relativePath]
  const pendingRefresh = record?.pendingRefresh
  if (!pendingRefresh) {
    return { bucket: reconnectBucket.onlyLocal, reason: 'no_pending_refresh', record: record ?? null }
  }

  const fakeCloud = {
    files: {
      [relativePath]: {
        hash: pendingRefresh.hash,
        revision: pendingRefresh.revision,
        kind: kind ?? 'file',
      },
    },
  }
  // The recorded base revision is the last revision this device's local save
  // committed at (or null if it never has). The pending refresh's revision is
  // guaranteed different (it is only set when a refresh materializes changed
  // content after that point), so this always lands on the "both touched"
  // path in classifyReconnectEntry.
  const fakeEntry = {
    path: relativePath,
    type: 'write',
    kind: kind ?? 'file',
    hash: newHash,
    baseRevision: record?.lastLocalSaveRevision ?? null,
  }

  const classification = classifyReconnectEntry(fakeCloud, fakeEntry)
  if (classification.bucket !== reconnectBucket.diverged) {
    return { ...classification, record }
  }

  if (buildsOnRefreshedContent(newContent, refreshedContent)) {
    return { ...classification, bucket: reconnectBucket.autoResolved, reason: 'builds_on_refreshed_content', record }
  }

  return { ...classification, record }
}

// "Builds on" is checked as literal containment of the refreshed text inside
// the new save: a stale-buffer save that never incorporated the refresh will
// not contain it, while an edit that started from (or merged in) the
// refreshed content will. Binary content (or anything that doesn't decode as
// UTF-8) has no meaningful lineage check beyond the hash equality already
// handled by classifyReconnectEntry, so it never "builds on" here.
export function buildsOnRefreshedContent(newContent, refreshedContent) {
  const newText = textOrNull(newContent)
  const refreshedText = textOrNull(refreshedContent)
  if (newText === null || refreshedText === null) return false
  if (refreshedText.length === 0) return true
  return newText.includes(refreshedText)
}

function textOrNull(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8')
    return Buffer.from(text, 'utf8').equals(value) ? text : null
  }
  return null
}
