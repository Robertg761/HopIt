// @ts-check
// Friendly context for the "Add a project" folder picker. Before running any
// side effect, the app tells the user what will happen and flags the two cases
// that should divert them: the folder is already inside the HopIt Workspace Root
// (it is a managed folder, not an import source), or it is already a connected
// project's managed workspace. The size/count comes from a bounded local walk
// using the same skip set the CLI import uses, so the estimate is cheap.

import fs from 'node:fs'
import path from 'node:path'

// Directories the agent import skips; keep in rough sync with the CLI so the
// count reflects what would actually be uploaded.
export const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'out',
  '.vercel',
  '.turbo',
  'coverage',
  '.DS_Store',
  '.hopit-agent',
  'artifacts',
])

/**
 * Pure classification of a picked folder against the workspace root and the
 * known projects. No filesystem access: callers pass the walk result in.
 * @param {{
 *   folderPath: string,
 *   workspaceRoot: string,
 *   projects?: Array<{ codebaseId: string, name?: string, workspacePath?: string|null }>,
 *   walk?: { fileCount: number, totalBytes: number, truncated: boolean } | null,
 * }} input
 */
export function classifyPickedFolder(input) {
  const folderPath = path.resolve(input.folderPath)
  const workspaceRoot = path.resolve(input.workspaceRoot)
  const projects = input.projects ?? []

  const insideWorkspaceRoot = isInside(folderPath, workspaceRoot) || folderPath === workspaceRoot
  const managedProject = projects.find(
    (project) => project.workspacePath && path.resolve(project.workspacePath) === folderPath,
  )

  let recommendation = 'add'
  let headline = 'This folder will become a HopIt project.'
  let description =
    'Its files will be copied to HopIt Cloud and appear as a managed project. Your original folder stays exactly where it is.'

  if (managedProject) {
    recommendation = 'open-existing'
    headline = `This is already the managed folder for “${managedProject.name ?? managedProject.codebaseId}”.`
    description = 'Open the existing project instead of adding it again.'
  } else if (insideWorkspaceRoot) {
    recommendation = 'blocked-inside-root'
    headline = 'This folder is inside your HopIt Workspace Root.'
    description =
      'Folders here are already managed by HopIt. Pick a normal project folder from elsewhere on your Mac to add it.'
  }

  return {
    folderPath,
    insideWorkspaceRoot,
    existingProjectId: managedProject?.codebaseId ?? null,
    existingProjectName: managedProject?.name ?? null,
    fileCount: input.walk?.fileCount ?? null,
    totalBytes: input.walk?.totalBytes ?? null,
    truncated: input.walk?.truncated ?? false,
    recommendation,
    headline,
    description,
  }
}

/**
 * Bounded recursive walk to estimate file count + byte size, skipping the same
 * heavy directories the importer ignores. Caps the number of entries so a huge
 * tree cannot hang the picker; `truncated` signals the cap was hit.
 * @param {string} folderPath
 * @param {{ skipDirs?: Set<string>, maxEntries?: number }} [opts]
 */
export function walkFolderStats(folderPath, opts = {}) {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS
  const maxEntries = opts.maxEntries ?? 25000
  let fileCount = 0
  let totalBytes = 0
  let truncated = false
  /** @type {string[]} */
  const stack = [folderPath]

  while (stack.length) {
    if (fileCount >= maxEntries) {
      truncated = true
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(/** @type {string} */ (dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        stack.push(path.join(/** @type {string} */ (dir), entry.name))
      } else if (entry.isFile()) {
        fileCount += 1
        try {
          totalBytes += fs.statSync(path.join(/** @type {string} */ (dir), entry.name)).size
        } catch {
          // ignore unreadable file
        }
        if (fileCount >= maxEntries) {
          truncated = true
          break
        }
      }
    }
  }
  return { fileCount, totalBytes, truncated }
}

/** Full impure inspection: walk + classify. */
export function inspectFolder(folderPath, { workspaceRoot, projects }) {
  const walk = walkFolderStats(folderPath)
  return classifyPickedFolder({ folderPath, workspaceRoot, projects, walk })
}

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Human byte size, e.g. "1.2 MB". */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return 'Not available'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
