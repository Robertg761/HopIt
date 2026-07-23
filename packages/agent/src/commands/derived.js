// @ts-check
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { curatedDerivedPathRules } from '../constants.js'
import { reportResult } from '../output.js'
import { listDerivedWorkspaceRoots } from '../workspace-manifest.js'

// `hop derived list|add|remove <path>` (GR-C1, decisions §6). Overrides are
// per-codebase and stored in `codebase_settings.derived_path_overrides`
// (source of truth for other devices); this command is the only mutation
// path today (dashboard settings surface stays behind a flag). `remove`
// un-derives a curated built-in path so it syncs again; `add` extends the
// curated list with a custom derived path that stops syncing.
export async function runDerivedCommand(action = 'list', pathArg = null, options = {}) {
  switch (action) {
    case 'list':
      return runDerivedList(options)
    case 'add':
      return runDerivedMutate('add', pathArg, options)
    case 'remove':
      return runDerivedMutate('remove', pathArg, options)
    default:
      throw new Error(`Unknown derived command: ${action}. Try: hop derived list | hop derived add <path> | hop derived remove <path>`)
  }
}

async function runDerivedList(options) {
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)
  const settings = await service.readCodebaseSettings(codebaseId)
  const excludedRoots = await listDerivedWorkspaceRoots(options.workspace, {
    derivedPathOverrides: settings.derivedPathOverrides,
  })

  const result = {
    ok: true,
    codebaseId,
    builtin: curatedDerivedPathRules,
    overrides: settings.derivedPathOverrides,
    excludedRoots,
  }

  reportResult(options, result, ({ line, accent, muted }) => {
    line(`  ${accent('•')} ${curatedDerivedPathRules.length} built-in derived path${curatedDerivedPathRules.length === 1 ? '' : 's'} ${muted(`(codebase ${codebaseId})`)}`)
    if (settings.derivedPathOverrides.add.length > 0) {
      line(`    ${muted('added:')} ${settings.derivedPathOverrides.add.join(', ')}`)
    }
    if (settings.derivedPathOverrides.remove.length > 0) {
      line(`    ${muted('un-derived:')} ${settings.derivedPathOverrides.remove.join(', ')}`)
    }
    if (excludedRoots.length === 0) {
      line(`    ${muted('No derived roots present in the workspace right now.')}`)
    } else {
      line(`    ${muted('excluded from sync:')} ${excludedRoots.join(', ')}`)
    }
  })
  return result
}

async function runDerivedMutate(kind, pathArg, options) {
  if (!pathArg) {
    throw new Error(`Usage: hop derived ${kind} <path>`)
  }
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)
  const settings = await service.readCodebaseSettings(codebaseId)
  const otherKind = kind === 'add' ? 'remove' : 'add'
  const currentList = settings.derivedPathOverrides[kind]
  const nextList = currentList.includes(pathArg) ? currentList : [...currentList, pathArg]
  // Adding to one list and being present on the other is contradictory
  // (e.g. `add foo` after `remove foo`); the newer intent wins.
  const otherList = settings.derivedPathOverrides[otherKind].filter((value) => value !== pathArg)

  const updated = await service.setDerivedPathOverrides(codebaseId, {
    [kind]: nextList,
    [otherKind]: otherList,
  })

  const result = { ok: true, codebaseId, path: pathArg, action: kind, ...updated }
  reportResult(options, result, ({ line, success, muted }) => {
    const verb = kind === 'add' ? 'Marked derived (stops syncing)' : 'Un-derived (syncs again)'
    line(`  ${success('✓')} ${verb}: ${pathArg} ${muted(`(codebase ${codebaseId})`)}`)
  })
  return result
}

function resolveCodebaseId(service, options) {
  return (
    options['codebase-id'] ||
    service.codebaseId ||
    process.env.HOPIT_CODEBASE_ID ||
    'hopit'
  )
}
