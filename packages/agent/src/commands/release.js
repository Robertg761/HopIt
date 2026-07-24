// @ts-check
// GR-B4 (decisions §9): `hop release <name> [--notes]` and `hop release list`.
// A release is a lightweight, permanent pin of the current Main revision --
// name, optional notes, pinned revision, created_at. It never mutates Main
// or any file; it is a pointer row, like a git tag without git (decisions
// §9: "answers exactly what shipped as v1.2 without git tags in the
// product"). GR-E3 (a later task, not implemented here) reads the releases
// table to emit an actual git tag on the mirror when one is configured.
import { DuplicateReleaseNameError } from '@hopit/backend-d1'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { emit } from '../io.js'
import { actorIdFromOptions } from '../journal.js'
import { reportResult } from '../output.js'

export async function runReleaseCommand(action = 'create', nameArg = null, options = {}) {
  switch (action) {
    case 'list':
      return runReleaseList(options)
    case 'create':
      return runReleaseCreate(nameArg, options)
    default:
      throw new Error(`Unknown release command: ${action}. Try: hop release <name> [--notes <text>] | hop release list`)
  }
}

// `hop release <name> [--notes <text>]`: pins the codebase's *current* Main
// revision (not the caller's active change set -- a release always describes
// what is actually live on Main right now).
export async function createRelease(options, { name, notes } = {}) {
  if (!name) throw new Error('Usage: hop release <name> [--notes <text>]')

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)
  const codebaseId = cloud.codebase.id

  let release
  try {
    release = await cloudService.createRelease(codebaseId, {
      name,
      notes: notes ?? null,
      pinnedRevision: cloud.main.revision,
      actorId,
      now,
    })
  } catch (error) {
    if (error instanceof DuplicateReleaseNameError || error?.code === 'duplicate_release_name') {
      throw new Error(`A release named "${name}" already exists for this codebase. Choose a different name.`)
    }
    throw error
  }

  await emit(options, 'release.created', {
    releaseId: release.releaseId,
    codebaseId,
    name: release.name,
    notes: release.notes,
    pinnedRevision: release.pinnedRevision,
    createdByUserId: release.createdByUserId,
  })

  return release
}

async function runReleaseCreate(nameArg, options) {
  const name = nameArg || options.name
  const release = await createRelease(options, { name, notes: options.notes ?? null })

  reportResult(options, { ok: true, release }, ({ line, success, muted }) => {
    line(`  ${success('✓')} Released ${release.name} ${muted(`(Main rev ${release.pinnedRevision})`)}`)
    if (release.notes) line(`    ${muted(release.notes)}`)
  })
  return release
}

async function runReleaseList(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase.id
  const releases = await cloudService.listReleases(codebaseId)

  const result = { ok: true, codebaseId, releases }
  reportResult(options, result, ({ line, accent, muted }) => {
    if (releases.length === 0) {
      line(`  ${muted('No releases yet.')} ${muted('Create one with: hop release <name>')}`)
      return
    }
    for (const release of releases) {
      line(`  ${accent('•')} ${release.name} ${muted(`(rev ${release.pinnedRevision}, ${release.createdAt})`)}`)
    }
  })
  return result
}
