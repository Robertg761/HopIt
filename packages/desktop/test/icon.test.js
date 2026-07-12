import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'

import { renderTrayIconPng, renderAllTrayIcons, encodePng } from '../src/lib/icon.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readIhdr(png) {
  // signature(8) + length(4) + "IHDR"(4)
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  }
}

test('every tray state renders a structurally valid PNG at both scales', () => {
  const icons = renderAllTrayIcons()
  assert.deepEqual(
    Object.keys(icons).sort(),
    ['all-synced', 'attention', 'service-stopped', 'syncing'],
  )
  for (const [state, { png1x, png2x }] of Object.entries(icons)) {
    for (const [png, size] of [[png1x, 22], [png2x, 44]]) {
      assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${state} has a PNG signature`)
      const ihdr = readIhdr(png)
      assert.equal(ihdr.width, size)
      assert.equal(ihdr.height, size)
      assert.equal(ihdr.bitDepth, 8)
      assert.equal(ihdr.colorType, 6) // RGBA
    }
  }
})

test('IDAT inflates to the expected scanline length and states differ visually', () => {
  const size = 22
  const decoded = {}
  for (const state of ['all-synced', 'syncing', 'attention', 'service-stopped']) {
    const png = renderTrayIconPng(state, { size })
    const idatStart = png.indexOf(Buffer.from('IDAT'))
    const length = png.readUInt32BE(idatStart - 4)
    const idat = png.subarray(idatStart + 4, idatStart + 4 + length)
    const raw = zlib.inflateSync(idat)
    assert.equal(raw.length, (size * 4 + 1) * size)
    decoded[state] = raw
    // Some pixels must be opaque (the disc) and the corners transparent.
    assert.ok(raw.includes(255), `${state} has opaque pixels`)
    assert.equal(raw[1 + 3], 0, `${state} corner pixel is transparent`) // first pixel alpha
  }
  // Distinct states produce distinct bitmaps (different colour/glyph).
  assert.notDeepEqual(decoded['all-synced'], decoded['attention'])
  assert.notDeepEqual(decoded['syncing'], decoded['service-stopped'])
})

test('an unknown state falls back to the stopped icon rather than throwing', () => {
  const png = renderTrayIconPng('nonsense')
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE))
})

test('encodePng round-trips a hand-built 2x2 image', () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255,  0, 255, 0, 255,
    0, 0, 255, 255,  0, 0, 0, 0,
  ])
  const png = encodePng(rgba, 2, 2)
  const ihdr = readIhdr(png)
  assert.equal(ihdr.width, 2)
  assert.equal(ihdr.height, 2)
  const idatStart = png.indexOf(Buffer.from('IDAT'))
  const length = png.readUInt32BE(idatStart - 4)
  const raw = zlib.inflateSync(png.subarray(idatStart + 4, idatStart + 4 + length))
  // filter byte 0 + 8 bytes per row
  assert.deepEqual([...raw.subarray(1, 9)], [255, 0, 0, 255, 0, 255, 0, 255])
})
