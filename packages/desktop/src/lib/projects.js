// @ts-check
// Enumerate connected codebases the same way the CLI menu does: the workspace
// index (state-root/workspaces.json) is the source of names/paths/hydration, and
// the per-codebase connection store fills in codebases that were added via
// `hop add` but may not yet have an index row. Live sync state is read from each
// codebase's status endpoint separately (see status-client.js).

import fs from 'node:fs/promises'
import { deriveServicePort, statusUrlForCodebase, eventsUrlForCodebase } from './ports.js'
import { workspaceIndexPath, connectionsDir } from './paths.js'

/**
 * Merge an index JSON and a list of connection-store codebase ids into a stable,
 * de-duplicated project list. Pure.
 * @param {any} indexJson parsed workspaces.json (or null)
 * @param {string[]} connectionIds codebase ids from the connection store
 */
export function listProjectsFromIndex(indexJson, connectionIds = []) {
  const byId = new Map()
  for (const entry of indexJson?.codebases ?? []) {
    if (!entry?.id) continue
    byId.set(entry.id, {
      codebaseId: entry.id,
      name: entry.name ?? entry.id,
      workspacePath: entry.workspace?.path ?? null,
      workspaceRoot: entry.workspace?.root ?? indexJson?.root?.path ?? null,
      activeChangeSetId: entry.activeChangeSetId ?? null,
      mainId: entry.mainId ?? null,
      hydrationState: entry.hydration?.state ?? entry.materialization ?? null,
    })
  }
  for (const id of connectionIds) {
    if (!id || byId.has(id)) continue
    byId.set(id, {
      codebaseId: id,
      name: id,
      workspacePath: null,
      workspaceRoot: null,
      activeChangeSetId: null,
      mainId: null,
      hydrationState: null,
    })
  }
  return [...byId.values()]
    .map((project) => ({
      ...project,
      port: deriveServicePort(project.codebaseId),
      statusUrl: statusUrlForCodebase(project.codebaseId),
      eventsUrl: eventsUrlForCodebase(project.codebaseId),
    }))
    .sort((a, b) => a.codebaseId.localeCompare(b.codebaseId))
}

/** Read connection-store codebase ids (filenames) from disk. Empty on ENOENT. */
export async function readConnectionCodebaseIds(stateRoot) {
  try {
    const entries = await fs.readdir(connectionsDir(stateRoot), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'ENOENT') return []
    throw error
  }
}

/** Read + parse the workspace index JSON from disk. Null on ENOENT/parse error. */
export async function readWorkspaceIndexJson(stateRoot) {
  try {
    const raw = await fs.readFile(workspaceIndexPath(stateRoot), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Full impure read: index + connections -> project list for a state root. */
export async function readProjects(stateRoot) {
  const [indexJson, connectionIds] = await Promise.all([
    readWorkspaceIndexJson(stateRoot),
    readConnectionCodebaseIds(stateRoot),
  ])
  return listProjectsFromIndex(indexJson, connectionIds)
}

/** Read the global default root and project rows from one consistent index snapshot. */
export async function readWorkspaceOverview(stateRoot) {
  const [indexJson, connectionIds] = await Promise.all([
    readWorkspaceIndexJson(stateRoot),
    readConnectionCodebaseIds(stateRoot),
  ])
  return {
    workspaceRoot: indexJson?.root?.path ?? null,
    projects: listProjectsFromIndex(indexJson, connectionIds),
  }
}
