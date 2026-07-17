#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(desktopRoot, 'assets', 'HopIt-icon.svg')
const outputPath = path.join(desktopRoot, 'assets', 'HopIt.icns')

const entries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]

const source = await fs.readFile(sourcePath)
const chunks = []

for (const [type, size] of entries) {
  const png = await sharp(source).resize(size, size).png().toBuffer()
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.write(type, 0, 4, 'ascii')
  chunkHeader.writeUInt32BE(png.length + chunkHeader.length, 4)
  chunks.push(chunkHeader, png)
}

const payloadLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
const fileHeader = Buffer.alloc(8)
fileHeader.write('icns', 0, 4, 'ascii')
fileHeader.writeUInt32BE(fileHeader.length + payloadLength, 4)

await fs.writeFile(outputPath, Buffer.concat([fileHeader, ...chunks]))
console.log(outputPath)
