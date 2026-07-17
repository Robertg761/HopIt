// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertWorkspacePathSafe } from '../paths.js'
import { readWorkspaceIndex, writeWorkspaceIndex } from '../workspace-index.js'
import { isPathInside } from '../workspace-manifest.js'

/** Move selected managed projects and make the destination the default root. */
export async function migrateWorkspaceRoot(options) {
  const newRoot = path.resolve(String(options['new-root'] ?? ''))
  if (!options['new-root'] || !path.isAbsolute(String(options['new-root']))) {
    throw new Error('workspace migrate-root requires an absolute --new-root path.')
  }
  await assertWorkspacePathSafe({ workspace: newRoot })

  const projectIds = parseProjectIds(options.projects)
  const originalIndex = await readWorkspaceIndex(options)
  if (!originalIndex) throw new Error('The HopIt workspace index does not exist yet.')
  const byId = new Map((originalIndex.codebases ?? []).map((entry) => [entry.id, entry]))
  const missing = projectIds.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`Unknown HopIt project${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)

  const moves = projectIds.map((id) => {
    const entry = byId.get(id)
    const source = path.resolve(entry.workspace?.path ?? '')
    if (!entry.workspace?.path) throw new Error(`Project ${id} has no managed workspace path.`)
    const destination = path.join(newRoot, path.basename(source))
    return { id, entry, source, destination }
  })
  await validateMoves(moves, newRoot)

  const envPath = path.resolve(
    options['env-path'] ?? process.env.HOPIT_ENV_FILE ?? path.join(os.homedir(), '.config', 'hopit', 'production.env'),
  )
  const originalEnv = await readOptionalFile(envPath)
  const completed = []
  let indexWritten = false
  let envWritten = false

  try {
    await fs.mkdir(newRoot, { recursive: true })
    for (const move of moves) {
      if (move.source !== move.destination) {
        await moveDirectoryVerified(move.source, move.destination)
        completed.push(move)
      }
    }

    const now = new Date().toISOString()
    const destinations = new Map(moves.map((move) => [move.id, move.destination]))
    const nextIndex = {
      ...originalIndex,
      updatedAt: now,
      root: {
        ...(originalIndex.root ?? {}),
        path: newRoot,
      },
      codebases: (originalIndex.codebases ?? []).map((entry) => {
        const destination = destinations.get(entry.id)
        if (!destination) return entry
        return {
          ...entry,
          updatedAt: now,
          workspace: {
            ...(entry.workspace ?? {}),
            root: newRoot,
            path: destination,
            exists: true,
          },
        }
      }),
    }
    await writeWorkspaceIndex(options, nextIndex)
    indexWritten = true
    await writeWorkspaceRootEnv(envPath, newRoot, originalEnv)
    envWritten = true

    return {
      ok: true,
      action: 'workspace-root-migrated',
      workspaceRoot: newRoot,
      migrated: moves.map((move) => ({
        codebaseId: move.id,
        from: move.source,
        to: move.destination,
      })),
      stayed: (originalIndex.codebases ?? [])
        .filter((entry) => !destinations.has(entry.id))
        .map((entry) => ({ codebaseId: entry.id, path: entry.workspace?.path ?? null })),
    }
  } catch (error) {
    if (envWritten || originalEnv !== null) await restoreOptionalFile(envPath, originalEnv).catch(() => {})
    if (indexWritten) await writeWorkspaceIndex(options, originalIndex).catch(() => {})
    for (const move of completed.reverse()) {
      await moveDirectoryVerified(move.destination, move.source).catch(() => {})
    }
    throw error
  }
}

export function parseProjectIds(value) {
  return [...new Set(String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean))]
}

async function validateMoves(moves, newRoot) {
  const destinations = new Set()
  for (const move of moves) {
    const sourceStat = await statOptional(move.source)
    if (!sourceStat?.isDirectory()) throw new Error(`Managed project folder is missing: ${move.source}`)
    if (isPathInside(newRoot, move.source) || newRoot === move.source) {
      throw new Error(`The new Workspace Root cannot be inside the project ${move.id}.`)
    }
    if (destinations.has(move.destination)) throw new Error(`Two projects would use the same destination: ${move.destination}`)
    destinations.add(move.destination)
    if (move.source !== move.destination && await statOptional(move.destination)) {
      throw new Error(`The destination already exists: ${move.destination}`)
    }
  }
}

/** Rename on one volume; verified copy then removal across volumes. */
export async function moveDirectoryVerified(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.rename(source, destination)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }

  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.hopit-migrate-${randomUUID()}`)
  try {
    await fs.cp(source, temp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    const [sourceManifest, copiedManifest] = await Promise.all([directoryManifest(source), directoryManifest(temp)])
    if (JSON.stringify(sourceManifest) !== JSON.stringify(copiedManifest)) {
      throw new Error(`Could not verify the copied project at ${destination}. The original was not removed.`)
    }
    await fs.rename(temp, destination)
    try {
      await fs.rm(source, { recursive: true })
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function directoryManifest(root) {
  const rows = []
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute)
      if (entry.isSymbolicLink()) rows.push([relative, 'link', await fs.readlink(absolute)])
      else if (entry.isDirectory()) {
        rows.push([relative, 'directory'])
        await visit(absolute)
      } else {
        const stat = await fs.stat(absolute)
        rows.push([relative, 'file', stat.size])
      }
    }
  }
  await visit(root)
  return rows
}

async function writeWorkspaceRootEnv(envPath, newRoot, original) {
  const nextLine = `HOPIT_WORKSPACE_ROOT=${JSON.stringify(newRoot)}`
  const lines = original === null ? [] : original.split(/\r?\n/)
  let replaced = false
  const next = []
  for (const line of lines) {
    if (/^\s*(?:export\s+)?HOPIT_WORKSPACE_ROOT\s*=/.test(line)) {
      if (!replaced) next.push(nextLine)
      replaced = true
    } else {
      next.push(line)
    }
  }
  if (!replaced) next.push(nextLine)
  while (next.length > 0 && next.at(-1) === '') next.pop()
  await writeFileAtomic(envPath, `${next.join('\n')}\n`)
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, filePath)
}

async function restoreOptionalFile(filePath, original) {
  if (original === null) await fs.rm(filePath, { force: true })
  else await writeFileAtomic(filePath, original)
}

async function readOptionalFile(filePath) {
  try { return await fs.readFile(filePath, 'utf8') }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function statOptional(filePath) {
  try { return await fs.stat(filePath) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}
