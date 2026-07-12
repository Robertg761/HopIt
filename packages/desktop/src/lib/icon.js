// @ts-check
// Programmatic tray-icon generation. Produces small RGBA PNGs at runtime so the
// shell ships no binary image assets and needs no image library. Each tray state
// gets a distinct colour + glyph, drawn on a transparent canvas so it reads on
// both light and dark menu bars.
//
// The PNG encoder is minimal but standards-correct: 8-bit RGBA, a single
// zlib-deflated IDAT with per-scanline filter byte 0, and CRC32'd chunks.

import zlib from 'node:zlib'

/** Menu-bar state colours (RGBA). */
const STATE_COLORS = {
  'all-synced': [52, 199, 89, 255], // green
  syncing: [10, 132, 255, 255], // blue
  attention: [255, 159, 10, 255], // orange
  'service-stopped': [142, 142, 147, 255], // gray
}

const WHITE = [255, 255, 255, 255]

/** CRC32 table + function for PNG chunk checksums. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode an RGBA pixel buffer to a PNG.
 * @param {Uint8Array} rgba length must be width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // colour type: RGBA
  ihdr.writeUInt8(0, 10) // compression
  ihdr.writeUInt8(0, 11) // filter
  ihdr.writeUInt8(0, 12) // interlace

  // Prefix each scanline with filter byte 0.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = zlib.deflateSync(raw)

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeCanvas(size) {
  return new Uint8Array(size * size * 4) // transparent
}

function setPixel(buf, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  const i = (y * size + x) * 4
  buf[i] = color[0]
  buf[i + 1] = color[1]
  buf[i + 2] = color[2]
  buf[i + 3] = color[3]
}

function fillDisc(buf, size, cx, cy, radius, color) {
  const r2 = radius * radius
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      if (dx * dx + dy * dy <= r2) setPixel(buf, size, x, y, color)
    }
  }
}

/** Draw a thick line segment by covering pixels within `half` of the segment. */
function drawThickLine(buf, size, x0, y0, x1, y1, half, color) {
  const minX = Math.floor(Math.min(x0, x1) - half - 1)
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1)
  const minY = Math.floor(Math.min(y0, y1) - half - 1)
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1)
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy || 1
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq))
      const px = x0 + t * dx
      const py = y0 + t * dy
      const ddx = x - px
      const ddy = y - py
      if (ddx * ddx + ddy * ddy <= half * half) setPixel(buf, size, x, y, color)
    }
  }
}

/** Up-chevron (hop) glyph centred in the disc. */
function drawUpChevron(buf, size, cx, cy, color) {
  const arm = size * 0.18
  const half = Math.max(1, size * 0.06)
  const apexY = cy - size * 0.12
  const baseY = cy + size * 0.1
  drawThickLine(buf, size, cx - arm, baseY, cx, apexY, half, color)
  drawThickLine(buf, size, cx, apexY, cx + arm, baseY, half, color)
}

/** Exclamation glyph for the attention state. */
function drawBang(buf, size, cx, cy, color) {
  const half = Math.max(1, size * 0.07)
  drawThickLine(buf, size, cx, cy - size * 0.16, cx, cy + size * 0.06, half, color)
  fillDisc(buf, size, cx, cy + size * 0.17, half, color)
}

/** Hollow square glyph for the stopped state. */
function drawStopMark(buf, size, cx, cy, color) {
  const half = Math.max(1, size * 0.055)
  const s = size * 0.16
  drawThickLine(buf, size, cx - s, cy - s, cx + s, cy - s, half, color)
  drawThickLine(buf, size, cx + s, cy - s, cx + s, cy + s, half, color)
  drawThickLine(buf, size, cx + s, cy + s, cx - s, cy + s, half, color)
  drawThickLine(buf, size, cx - s, cy + s, cx - s, cy - s, half, color)
}

/**
 * Render a tray icon PNG for a state.
 * @param {'all-synced'|'syncing'|'attention'|'service-stopped'} trayState
 * @param {{ size?: number }} [opts]
 * @returns {Buffer}
 */
export function renderTrayIconPng(trayState, opts = {}) {
  const size = opts.size ?? 22
  const color = STATE_COLORS[trayState] ?? STATE_COLORS['service-stopped']
  const buf = makeCanvas(size)
  const c = size / 2
  fillDisc(buf, size, c, c, size * 0.44, color)
  if (trayState === 'attention') drawBang(buf, size, c, c, WHITE)
  else if (trayState === 'service-stopped') drawStopMark(buf, size, c, c, WHITE)
  else drawUpChevron(buf, size, c, c, WHITE)
  return encodePng(buf, size, size)
}

/** All four state icons at @1x and @2x, keyed by state. */
export function renderAllTrayIcons() {
  /** @type {Record<string, { png1x: Buffer, png2x: Buffer }>} */
  const out = {}
  for (const state of Object.keys(STATE_COLORS)) {
    out[state] = {
      png1x: renderTrayIconPng(/** @type {any} */ (state), { size: 22 }),
      png2x: renderTrayIconPng(/** @type {any} */ (state), { size: 44 }),
    }
  }
  return out
}
