export type DeviceCodebaseOption = {
  id: string
  name: string
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
