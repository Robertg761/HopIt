#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
if (tracked.status !== 0) {
  throw new Error(`Unable to list tracked files: ${tracked.stderr.toString('utf8')}`)
}

const prohibitedMark = Buffer.from([0xe2, 0x80, 0x94])
const violations = tracked.stdout
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((filePath) => fs.readFileSync(filePath).includes(prohibitedMark))

if (violations.length > 0) {
  console.error('HopIt copy contains the prohibited Unicode punctuation mark U+2014:')
  for (const filePath of violations) console.error(`  ${filePath}`)
  process.exitCode = 1
} else {
  console.log('HopIt copy style check passed.')
}
