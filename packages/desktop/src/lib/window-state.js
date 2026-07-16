// @ts-check
// Hand-rolled window-state persistence (position + size), in the spirit of the
// electron-window-state package but dependency-free and unit-tested. The pure
// functions validate/clamp bounds against the available display area; the impure
// load/save read and write a small JSON file under the app's userData dir.

import fs from 'node:fs'
import path from 'node:path'

/** Default window bounds when nothing is persisted. */
export const DEFAULT_BOUNDS = { width: 1040, height: 720 }

/**
 * Validate persisted bounds. Returns a clean bounds object (numbers only) or
 * null if the shape is unusable.
 * @param {any} raw
 */
export function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { x, y, width, height } = raw
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (width <= 0 || height <= 0) return null
  const bounds = { width: Math.round(width), height: Math.round(height) }
  if (typeof x === 'number') bounds.x = Math.round(x)
  if (typeof y === 'number') bounds.y = Math.round(y)
  return bounds
}

/**
 * Clamp bounds so the window is usable on the given work area. Keeps the window
 * from being larger than the screen or positioned entirely off-screen.
 * @param {{x?:number,y?:number,width:number,height:number}} bounds
 * @param {{x:number,y:number,width:number,height:number}} workArea
 */
export function clampToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  const result = { width, height }
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    const maxX = workArea.x + workArea.width - width
    const maxY = workArea.y + workArea.height - height
    // Require at least a sliver on screen; otherwise drop x/y to re-center.
    const onScreen =
      bounds.x < workArea.x + workArea.width &&
      bounds.x + width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + height > workArea.y
    if (onScreen) {
      result.x = Math.max(workArea.x, Math.min(bounds.x, maxX))
      result.y = Math.max(workArea.y, Math.min(bounds.y, maxY))
    }
  }
  return result
}

/**
 * Resolve the bounds to open with, given persisted raw state and the current
 * work area. Pure: the composition tested end-to-end.
 * @param {any} rawPersisted
 * @param {{x:number,y:number,width:number,height:number}} workArea
 */
export function resolveInitialBounds(rawPersisted, workArea) {
  const normalized = normalizeBounds(rawPersisted) ?? { ...DEFAULT_BOUNDS }
  return clampToWorkArea(normalized, workArea)
}

/** Path of the persisted state file within userData. */
export function windowStatePath(userDataDir) {
  return path.join(userDataDir, 'window-state.json')
}

/** Load raw persisted bounds (or null). Impure. */
export function loadWindowState(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath(userDataDir), 'utf8'))
  } catch {
    return null
  }
}

/** Persist bounds atomically-ish. Impure; never throws to the caller. */
export function saveWindowState(userDataDir, bounds) {
  const clean = normalizeBounds(bounds)
  if (!clean) return
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(windowStatePath(userDataDir), JSON.stringify(clean, null, 2))
  } catch {
    // Best-effort; losing window position is not worth crashing the app.
  }
}
