// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeSecureJson } from './io.js'
import { agentStateRootFromOptions } from './workspace-index.js'

// Per-codebase connection entries let a single device drive more than one HopIt
// codebase. Agent session tokens (hst_) are scoped to exactly one codebase, and
// the primary production env file only carries the token for HOPIT_CODEBASE_ID.
// Every additional codebase connected through `hop add` stores its own scoped
// token here, at <state-root>/connections/<codebaseId>.json (mode 0600).

/** A codebase id must be a safe single path segment for the store filename. */
export function assertSafeConnectionCodebaseId(codebaseId) {
  const value = typeof codebaseId === 'string' ? codebaseId.trim() : ''
  if (!value) throw new Error('Codebase id is required.')
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error(`Unsafe codebase id for connection store: ${codebaseId}`)
  }
  return value
}

export function connectionsDir(options) {
  return path.join(path.resolve(agentStateRootFromOptions(options)), 'connections')
}

export function connectionEntryPath(options, codebaseId) {
  return path.join(connectionsDir(options), `${assertSafeConnectionCodebaseId(codebaseId)}.json`)
}

export async function readConnectionEntry(options, codebaseId) {
  let entryPath
  try {
    entryPath = connectionEntryPath(options, codebaseId)
  } catch {
    return null
  }
  try {
    return await readJson(entryPath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeConnectionEntry(options, connection) {
  const codebaseId = assertSafeConnectionCodebaseId(connection.codebaseId)
  const entry = {
    kind: 'hopit-codebase-connection',
    codebaseId,
    sessionId: connection.sessionId ?? null,
    sessionToken: connection.sessionToken ?? null,
    requesterId: connection.requesterId ?? null,
    apiBaseUrl: connection.apiBaseUrl ?? null,
    remotePushUrl: connection.remotePushUrl ?? null,
    createdAt: connection.createdAt ?? new Date().toISOString(),
  }
  const entryPath = connectionEntryPath(options, codebaseId)
  await writeSecureJson(entryPath, entry)
  return { path: entryPath, entry }
}

/** Local connection codebase ids, used for default-id collision checks. */
export async function listConnectionCodebaseIds(options) {
  let entries
  try {
    entries = await fs.readdir(connectionsDir(options), { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
}

/**
 * Transparently resolve a per-codebase connection when a command targets a
 * codebase that is not the one owned by the primary env config. Explicit flags
 * and the env codebase's own values always win; the store only fills scoped
 * identity/token values for a *different* codebase whose env token would not
 * match.
 */
export async function applyConnectionStore(options) {
  const provided = options._provided ?? new Set()
  const targetCodebase = typeof options['codebase-id'] === 'string' ? options['codebase-id'].trim() : ''
  if (!targetCodebase) return options

  // The primary env-based config owns its codebase. Never override it: this
  // keeps the default 'hopit' env path working exactly as before.
  const envCodebase = typeof process.env.HOPIT_CODEBASE_ID === 'string'
    ? process.env.HOPIT_CODEBASE_ID.trim()
    : ''
  if (envCodebase && targetCodebase === envCodebase) return options

  let entry
  try {
    entry = await readConnectionEntry(options, targetCodebase)
  } catch {
    return options
  }
  if (!entry) return options

  const next = { ...options, _connectionStore: entry }
  if (!provided.has('session-token') && entry.sessionToken) next['session-token'] = entry.sessionToken
  if (!provided.has('session-id') && entry.sessionId) next['session-id'] = entry.sessionId
  if (!provided.has('requester-id') && entry.requesterId) next['requester-id'] = entry.requesterId
  if (!provided.has('d1-api-base-url') && entry.apiBaseUrl) next['d1-api-base-url'] = entry.apiBaseUrl
  if (!provided.has('remote-push-url') && entry.remotePushUrl) next['remote-push-url'] = entry.remotePushUrl
  return next
}
