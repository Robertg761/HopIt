export type DeviceCodebaseOption = {
  id: string
  name: string
}

/**
 * Gate the device-approval "Approve this device" action. When the terminal asked
 * to CREATE a specific project that does not exist yet, approving a DIFFERENT
 * existing project would silently make the device operate on (and, via import,
 * overwrite) that project. That must never be a one-click action: the user has to
 * both pick an existing project AND acknowledge the override warning. Once the
 * requested project is created (`requestedExists` becomes true) this collapses to
 * the ordinary "a selection is required" rule.
 */
export function deviceApprovalGate(input: {
  requestedId: string | null
  requestedExists: boolean
  selectedCodebaseId: string
  overrideAcknowledged: boolean
  busy?: boolean
}): { requestedNeedsCreate: boolean; canApprove: boolean } {
  const requestedNeedsCreate = Boolean(input.requestedId?.trim()) && !input.requestedExists
  const hasSelection = input.selectedCodebaseId.trim().length > 0
  const canApprove = !input.busy
    && hasSelection
    && (!requestedNeedsCreate || input.overrideAcknowledged)
  return { requestedNeedsCreate, canApprove }
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
