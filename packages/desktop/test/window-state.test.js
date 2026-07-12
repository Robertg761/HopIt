import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  normalizeBounds,
  clampToWorkArea,
  resolveInitialBounds,
  loadWindowState,
  saveWindowState,
  DEFAULT_BOUNDS,
} from '../src/lib/window-state.js'

const workArea = { x: 0, y: 25, width: 1512, height: 950 }

test('normalizeBounds rejects junk and keeps valid shapes', () => {
  assert.equal(normalizeBounds(null), null)
  assert.equal(normalizeBounds({}), null)
  assert.equal(normalizeBounds({ width: -5, height: 100 }), null)
  assert.deepEqual(normalizeBounds({ width: 800.4, height: 600.6 }), { width: 800, height: 601 })
  assert.deepEqual(normalizeBounds({ x: 10, y: 20, width: 800, height: 600 }), { x: 10, y: 20, width: 800, height: 600 })
})

test('bounds larger than the screen are shrunk to fit', () => {
  const clamped = clampToWorkArea({ width: 4000, height: 3000 }, workArea)
  assert.deepEqual(clamped, { width: 1512, height: 950 })
})

test('an off-screen position is dropped so the window re-centers', () => {
  const clamped = clampToWorkArea({ x: -9000, y: -9000, width: 800, height: 600 }, workArea)
  assert.equal(clamped.x, undefined)
  assert.equal(clamped.y, undefined)
})

test('a partially visible position is nudged fully on screen', () => {
  const clamped = clampToWorkArea({ x: 1400, y: 900, width: 800, height: 600 }, workArea)
  assert.equal(clamped.x, workArea.x + workArea.width - 800)
  assert.equal(clamped.y, workArea.y + workArea.height - 600)
})

test('resolveInitialBounds falls back to defaults for missing state', () => {
  const bounds = resolveInitialBounds(null, workArea)
  assert.deepEqual(bounds, { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height })
})

test('save/load round-trips through the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopit-desktop-ws-'))
  try {
    saveWindowState(dir, { x: 40, y: 60, width: 900, height: 700 })
    const loaded = loadWindowState(dir)
    assert.deepEqual(loaded, { x: 40, y: 60, width: 900, height: 700 })
    const resolved = resolveInitialBounds(loaded, workArea)
    assert.deepEqual(resolved, { x: 40, y: 60, width: 900, height: 700 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('load returns null for a missing or corrupt file, and save ignores junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopit-desktop-ws-'))
  try {
    assert.equal(loadWindowState(dir), null)
    fs.writeFileSync(path.join(dir, 'window-state.json'), '{corrupt')
    assert.equal(loadWindowState(dir), null)
    saveWindowState(dir, { width: -1, height: -1 }) // invalid: must not overwrite
    assert.equal(loadWindowState(dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
