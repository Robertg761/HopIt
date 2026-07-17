import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'

import {
  resolveHopBinary,
  hopBinaryCandidates,
  defaultAgentStateRoot,
  bundledHopBinary,
  assertSafeAbsolutePath,
  assertPathWithin,
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

test('bundled runtime selects the matching universal-app architecture', () => {
  assert.equal(
    bundledHopBinary('/Applications/HopIt.app/Contents/Resources', 'arm64', 'darwin'),
    path.join('/Applications/HopIt.app/Contents/Resources', 'agent', 'hop-darwin-arm64', 'bin', 'hop'),
  )
  assert.equal(
    bundledHopBinary('/Applications/HopIt.app/Contents/Resources', 'x64', 'darwin'),
    path.join('/Applications/HopIt.app/Contents/Resources', 'agent', 'hop-darwin-x64', 'bin', 'hop'),
  )
  assert.equal(bundledHopBinary('/tmp/resources', 'arm64', 'linux'), null)
  assert.equal(bundledHopBinary('/tmp/resources', 'ia32', 'darwin'), null)
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

test('assertPathWithin confines a workspace-joined reveal to the project folder', () => {
  const root = '/Users/me/HopIt Workspaces/proj'
  // Legit files inside the workspace resolve unchanged.
  assert.equal(assertPathWithin(root, `${root}/src/app.js`), `${root}/src/app.js`)
  assert.equal(assertPathWithin(root, root), root)
  // A hostile agent/cloud-supplied file path that traverses upward is rejected,
  // where a plain absolute-path check (assertSafeAbsolutePath) would let it out.
  const hostile = `${root}/../../../../../../etc/passwd`
  assert.equal(assertSafeAbsolutePath(hostile), '/etc/passwd') // demonstrates the gap the confinement closes
  assert.throws(() => assertPathWithin(root, hostile), /escapes/)
  // A hostile filename with traversal embedded in the last segment.
  assert.throws(() => assertPathWithin(root, `${root}/a/../../../../tmp/evil`), /escapes/)
  // A sibling directory sharing a name prefix must not be treated as inside.
  assert.throws(() => assertPathWithin(root, '/Users/me/HopIt Workspaces/proj-evil/x'), /escapes/)
  // Bad roots and bad targets are rejected too.
  assert.throws(() => assertPathWithin('relative/root', `${root}/x`), /root/)
  assert.throws(() => assertPathWithin(root, 'relative/x'), /absolute/)
})

test('assertSafeCodebaseId matches the agent single-segment contract', () => {
  assert.equal(assertSafeCodebaseId('lunarlog'), 'lunarlog')
  assert.equal(assertSafeCodebaseId('  padded  '), 'padded')
  assert.throws(() => assertSafeCodebaseId('..'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId('a/b'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId('a\\b'), /Unsafe/)
  assert.throws(() => assertSafeCodebaseId(''), /required/)
})
