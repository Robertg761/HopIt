// @ts-check
// GR-D2 (decisions §7: "rotate, don't redact"). Pure derivation of the
// dismissible-per-finding secret list the tray/menu-bar renders. Sourced from
// the local status endpoint's `secretScan.recentSuspected` (raw
// `secret.suspected` event entries -- see packages/agent/src/status-endpoints.js
// `summarizeAgentEvents`), never re-scans or re-classifies anything itself:
// warn-only scanning already happened agent-side (GR-D1).

/**
 * Stable id for a single secret.suspected occurrence so dismissal survives
 * across polls (the same finding must not reappear once dismissed, and a
 * fresh finding at the same path after a later edit still gets its own id
 * because `at` differs). Falls back to path+at when the event carries no id.
 * @param {{ id?: string, at?: string, detail?: { path?: string } }} entry
 * @returns {string}
 */
export function secretFindingId(entry) {
  if (entry?.id) return String(entry.id)
  const path = entry?.detail?.path ?? 'unknown'
  const at = entry?.at ?? 'unknown'
  return `${path}::${at}`
}

/**
 * One human line + stable id per secret.suspected occurrence, newest first.
 * @param {Array<{id?: string, at?: string, detail?: {path?: string, findingCount?: number}}>} recentSuspected
 * @param {{ codebaseId?: string }} [context]
 */
export function deriveSecretFindings(recentSuspected, context = {}) {
  const entries = Array.isArray(recentSuspected) ? recentSuspected.slice() : []
  entries.reverse()
  return entries.map((entry) => {
    const path = entry?.detail?.path ?? null
    const findingCount = Number.isFinite(entry?.detail?.findingCount) ? entry.detail.findingCount : null
    return {
      id: secretFindingId(entry),
      codebaseId: context.codebaseId ?? null,
      path,
      findingCount,
      at: entry?.at ?? null,
      message: path ? `Possible secret in ${path}` : 'Possible secret found',
      guidance: "Rotate the credential -- don't rely on deleting or redacting it.",
    }
  })
}

/**
 * Filter out dismissed findings. Pure; the dismissed-id set lives in the
 * caller (the tray keeps it in memory per run -- dismissal is a "seen it,
 * stop flagging it" ack, not a server-side mutation, unlike the dashboard's
 * mark-read notification).
 * @param {ReturnType<typeof deriveSecretFindings>} findings
 * @param {Set<string>} dismissedIds
 */
export function openSecretFindings(findings, dismissedIds) {
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set()
  return (Array.isArray(findings) ? findings : []).filter((finding) => !dismissed.has(finding.id))
}
