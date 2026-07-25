// @ts-check
// Write-ahead journaling across a cloud outage.
//
// `performSyncOnce` has to read the cloud graph before it can plan anything:
// a journal entry needs a `baseRevision`, a privacy zone, a target state id
// and revision, and a before/after comparison to decide whether a path even
// changed. That made the graph read a hard prerequisite for journaling, so a
// cloud outage failed at the read and produced *no journal entry at all* --
// the writes survived only because they were still sitting on disk for
// GR-A4's startup diff-scan to find at reconnect. Recovery-on-restart, not a
// write-ahead journal.
//
// This module closes that gap the cheap way: every successful graph read
// snapshots the graph next to the journal, and when a later read fails
// because the cloud is unreachable, the sync plans against that snapshot
// instead. Entries come out fully formed and land in the journal as
// `pending`; nothing is committed, because there is nothing to commit to.
//
// The snapshot is allowed to be stale, and that is the point: planning
// against a stale revision is exactly the situation GR-A1's reconnect
// classification already exists for. When the cloud comes back,
// `recoverJournal` replays the pending entries and each one either replays
// cleanly, auto-resolves as identical content, or opens a divergence. No new
// conflict machinery, and no path where a stale snapshot silently overwrites
// a newer cloud revision.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { readJson, writeJson } from './io.js'

export const graphCacheSchemaVersion = 1

// Same convention as the GR-F2 writer ledger: sits next to the journal file
// it belongs to, so per-codebase journal paths (`journal/<codebaseId>.ndjson`)
// each get their own snapshot without a new CLI option.
export function graphCachePathFor(options) {
  const journalPath = options.journal
  const dir = path.dirname(journalPath)
  const base = path.basename(journalPath, path.extname(journalPath))
  return path.join(dir, `${base}.graph-cache.json`)
}

export async function writeCachedGraph(options, cloud) {
  if (!cloud || typeof cloud !== 'object') return
  await writeJson(graphCachePathFor(options), {
    schemaVersion: graphCacheSchemaVersion,
    cachedAt: new Date().toISOString(),
    graph: cloud,
  })
}

export async function readCachedGraph(options) {
  const cachePath = graphCachePathFor(options)
  if (!existsSync(cachePath)) return null
  try {
    const raw = await readJson(cachePath)
    if (raw?.schemaVersion !== graphCacheSchemaVersion) return null
    return raw?.graph && typeof raw.graph === 'object' ? raw.graph : null
  } catch {
    // A truncated or unparseable snapshot is treated as "no snapshot": the
    // caller then fails exactly the way it did before this module existed.
    return null
  }
}

// Node surfaces a genuine network failure as a `fetch` rejection -- a
// TypeError whose `cause` carries the socket errno -- because no HTTP
// response ever arrived. Anything the backend itself throws ("D1 query
// failed: ...", "D1 statement failed: ...") means a response *did* arrive and
// the server rejected the request: bad token, revoked session, malformed
// statement, quota. Those must keep failing loudly, because planning against
// a cached graph would paper over a real, non-transient problem.
//
// So this deliberately only says yes to transport-level failures, and
// defaults to no for anything it does not recognize. A false negative just
// restores today's behavior; a false positive would let the agent keep
// journaling against a stale graph while the real problem went unreported.
const unreachableErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

export function isCloudUnreachableError(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = typeof current.code === 'string' ? current.code : null
    if (code && unreachableErrorCodes.has(code)) return true
    current = current.cause
  }
  // `fetch` itself rejects with a bare `TypeError: fetch failed` whose cause
  // is not always populated (DNS and some TLS paths). The message check is
  // narrow on purpose: only this exact undici/WHATWG shape, never a general
  // "looks network-ish" match.
  return error instanceof TypeError && /fetch failed/i.test(error.message ?? '')
}
