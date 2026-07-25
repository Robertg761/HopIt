export type DeviceCodebaseOption = {
  id: string
  name: string
}

export type DeviceRequestedProject = {
  id: string
  name: string
}

/**
 * One row of a batch approval. `resolvedCodebaseId` is what the row will actually
 * connect to: equal to `requested.id` once that project has been created, or a
 * different existing project id when the user deliberately adopts one instead.
 */
export type DeviceProjectSelection = {
  requested: DeviceRequestedProject
  selected: boolean
  resolvedCodebaseId: string
  acknowledgedExisting: boolean
}

/**
 * Gate the batch "Approve this device" action.
 *
 * The rule that matters is per row, not per page: creating the project the
 * terminal asked for is safe and can be bulk-selected, but pointing a row at a
 * DIFFERENT existing project makes the device operate on (and, via import,
 * overwrite) that project. That must never ride along with a bulk approval, so
 * every adopting row carries its own acknowledgement. A row whose requested
 * project does not exist yet and has no resolved selection is not approvable at
 * all -- it has nothing to connect to.
 */
export function deviceBatchApprovalGate(input: {
  selections: DeviceProjectSelection[]
  existingCodebaseIds: string[]
  busy?: boolean
}): {
  selectedCount: number
  createCount: number
  adoptCount: number
  unacknowledgedAdoptCount: number
  incompleteCount: number
  canApprove: boolean
} {
  const existing = new Set(input.existingCodebaseIds)
  const active = input.selections.filter((entry) => entry.selected)
  let createCount = 0
  let adoptCount = 0
  let unacknowledgedAdoptCount = 0
  let incompleteCount = 0

  for (const entry of active) {
    const resolved = entry.resolvedCodebaseId.trim()
    if (!resolved) {
      incompleteCount += 1
      continue
    }
    if (resolved === entry.requested.id) {
      // Connecting to the requested project. Safe once it exists; if it does not
      // exist yet the row still needs the create step to run.
      if (existing.has(resolved)) createCount += 1
      else incompleteCount += 1
      continue
    }
    adoptCount += 1
    if (!entry.acknowledgedExisting) unacknowledgedAdoptCount += 1
  }

  return {
    selectedCount: active.length,
    createCount,
    adoptCount,
    unacknowledgedAdoptCount,
    incompleteCount,
    canApprove: !input.busy
      && active.length > 0
      && incompleteCount === 0
      && unacknowledgedAdoptCount === 0,
  }
}

export function normalizeDeviceCodebaseOptions(value: unknown): DeviceCodebaseOption[] {
  if (!Array.isArray(value)) return []

  const options: DeviceCodebaseOption[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = recordValue(entry)
    const codebase = recordValue(row?.codebase)
    const id = optionalText(codebase?.id) ?? optionalText(row?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    options.push({
      id,
      name: optionalText(codebase?.name) ?? optionalText(row?.name) ?? id,
    })
  }
  return options
}

export function normalizeDeviceRequestedProjects(value: unknown): DeviceRequestedProject[] {
  if (!Array.isArray(value)) return []

  const projects: DeviceRequestedProject[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const row = recordValue(entry)
    const id = optionalText(row?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    projects.push({ id, name: optionalText(row?.name) ?? id })
  }
  return projects
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
