import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VALID_TARGET_KEYS,
  hostTargetKey,
  parseTargets,
} from '../../../scripts/package-hop.mjs'

const keys = (targets) => targets.map((target) => target.key)

test('defaults to the host target when nothing is requested', () => {
  const targets = parseTargets({ argv: [], env: {}, host: 'darwin-arm64' })
  assert.deepEqual(keys(targets), ['darwin-arm64'])
  const [target] = targets
  assert.equal(target.platform, 'darwin')
  assert.equal(target.arch, 'arm64')
  assert.equal(target.exeName, 'node')
  assert.equal(target.launcherName, 'hop')
})

test('--target all expands to every valid target', () => {
  const targets = parseTargets({ argv: ['--target', 'all'], env: {} })
  assert.deepEqual(keys(targets), VALID_TARGET_KEYS)
  assert.deepEqual(VALID_TARGET_KEYS, ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
})

test('accepts comma-separated and repeated --target flags, deduped in order', () => {
  const csv = parseTargets({ argv: ['--target', 'linux-x64,darwin-x64'], env: {} })
  assert.deepEqual(keys(csv), ['linux-x64', 'darwin-x64'])

  const repeated = parseTargets({
    argv: ['--target', 'linux-x64', '--target=linux-x64', '-t', 'darwin-arm64'],
    env: {},
  })
  assert.deepEqual(keys(repeated), ['linux-x64', 'darwin-arm64'])
})

test('reads HOP_PACKAGE_TARGET from env', () => {
  const targets = parseTargets({ argv: [], env: { HOP_PACKAGE_TARGET: 'linux-arm64' } })
  assert.deepEqual(keys(targets), ['linux-arm64'])
})

test('rejects an invalid target', () => {
  assert.throws(
    () => parseTargets({ argv: ['--target', 'win32-x64'], env: {} }),
    /Unsupported packaging target: win32-x64/,
  )
})

test('throws when host is unsupported and no target is given', () => {
  assert.throws(
    () => parseTargets({ argv: [], env: {}, host: null }),
    /not a supported packaging target/,
  )
})

test('hostTargetKey maps known and unknown hosts', () => {
  assert.equal(hostTargetKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(hostTargetKey('linux', 'x64'), 'linux-x64')
  assert.equal(hostTargetKey('win32', 'x64'), null)
})
