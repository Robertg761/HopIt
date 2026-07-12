import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'

import {
  resolveHopBinary,
  hopBinaryCandidates,
  defaultAgentStateRoot,
  assertSafeAbsolutePath,
  assertSafeCodebaseId,
} from '../src/lib/paths.js'

const home = os.homedir()

test('candidate order: override, ~/.local/bin, homebrew, /usr/local, runtime', () => {
  const candidates = hopBinaryCandidates({ HOPIT_HOP_BIN: '/custom/hop' }, 'darwin')
  assert.equal(candidates[0], '/custom/hop')
  assert.equal(candidates[1], path.join(home, '.local', 'bin', 'hop'))
  assert.equal(candidates[2], '/opt/homebrew/bin/hop')
  assert.equal(candidates[3], '/usr/local/bin/hop')
  assert.ok(candidates[4].includes(path.join('HopIt', 'Runtime')))
  assert.ok(candidates[4].endsWith(path.join('bin', 'hop')))
})

test('resolver returns the first existing candidate', () => {
  const runtime = hopBinaryCandidates({}, 'darwin')[3] // /usr/local/bin/hop
  const resolved = resolveHopBinary({
    env: {},
    platform: 'darwin',
    fileExists: (p) => p === runtime,
  })
  assert.equal(resolved, runtime)
})

test('resolver honors the HOPIT_HOP_BIN override before install locations', () => {
  const resolved = resolveHopBinary({
    env: { HOPIT_HOP_BIN: '/repo/packages/agent/src/cli.js' },
    platform: 'darwin',
    fileExists: () => true,
  })
  assert.equal(resolved, '/repo/packages/agent/src/cli.js')
})

test('resolver returns null when nothing exists', () => {
  assert.equal(resolveHopBinary({ env: {}, platform: 'darwin', fileExists: () => false }), null)
})

test('linux candidates use the linux runtime layout', () => {
  const candidates = hopBinaryCandidates({}, 'linux')
  assert.ok(candidates.some((candidate) => candidate.includes(path.join('hopit', 'runtime'))))
  assert.ok(!candidates.some((candidate) => candidate.includes('Application Support')))
})

test('state root respects HOPIT_AGENT_STATE_ROOT and platform defaults', () => {
  assert.equal(defaultAgentStateRoot({ HOPIT_AGENT_STATE_ROOT: '/x/state' }, 'darwin'), '/x/state')
  assert.equal(
    defaultAgentStateRoot({}, 'darwin'),
    path.join(home, 'Library', 'Application Support', 'HopIt', 'Agent'),
  )
  assert.equal(defaultAgentStateRoot({}, 'linux'), path.join(home, '.local', 'state', 'hopit', 'agent'))
  assert.equal(defaultAgentStateRoot({ XDG_STATE_HOME: '/xdg' }, 'linux'), path.join('/xdg', 'hopit', 'agent'))
})

test('assertSafeAbsolutePath accepts absolute paths and rejects bad input', () => {
  assert.equal(assertSafeAbsolutePath('/Users/robert/Projects/thing'), '/Users/robert/Projects/thing')
  assert.throws(() => assertSafeAbsolutePath('relative/path'), /absolute/)
  assert.throws(() => assertSafeAbsolutePath(''), /required/)
  assert.throws(() => assertSafeAbsolutePath(42), /required/)
  assert.throws(() => assertSafeAbsolutePath('/a/b\0c'), /null byte/)
})

test('assertSafeCodebaseId matches the agent single-segment contract', () => {
  assert.equal(assertSafeCodebaseId('lunarlog'), 'lunarlog')
  assert.equal(assertSafeCodebaseId('  padded  '), 'padded')
  assert.throws(() => assertSafeCodebaseId('..'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId('a/b'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId('a\\b'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId(''), /required/)
})
