// @ts-check
// Per-codebase status-server port derivation.
//
// This is a deliberate, tiny reimplementation of `deriveServicePort` /
// `stableStringHash` from packages/agent/src/options.js so the desktop shell
// stays dependency-light and does not pull the agent's D1/core import graph into
// the Electron main process. The behaviour MUST stay identical to the agent:
// the default codebase keeps the historical base port and every other codebase
// gets a stable port in [4786, 5785] derived from an FNV-1a hash of its id.
// If the agent's derivation ever changes, update this in lockstep.

export const baseServicePort = 4785
export const defaultCodebaseId = 'hopit'

/** FNV-1a 32-bit hash, returned as an unsigned integer. Stable across runs. */
export function stableStringHash(value) {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic per-codebase status-server port. Mirrors the agent so a status
 * probe here resolves the exact port the codebase's service binds.
 * @param {string|null|undefined} codebaseId
 */
export function deriveServicePort(codebaseId) {
  if (!codebaseId || codebaseId === defaultCodebaseId) return baseServicePort
  return baseServicePort + 1 + (stableStringHash(codebaseId) % 1000)
}

/** Loopback status URL for a codebase id. */
export function statusUrlForCodebase(codebaseId) {
  return `http://127.0.0.1:${deriveServicePort(codebaseId)}/status`
}

/** Loopback events URL for a codebase id. */
export function eventsUrlForCodebase(codebaseId) {
  return `http://127.0.0.1:${deriveServicePort(codebaseId)}/events`
}
