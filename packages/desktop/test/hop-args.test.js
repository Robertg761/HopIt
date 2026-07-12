import assert from 'node:assert/strict'
import test from 'node:test'
import process from 'node:process'

import {
  hopSpawnEnv,
  streamHop,
  syncArgs,
  refreshArgs,
  serviceArgs,
  addArgs,
  hydratePathArgs,
  pinArgs,
  assertSafeCloudPath,
} from '../src/lib/hop.js'

test('human mode sets HOPIT_JSON=0, json mode sets HOPIT_JSON=1', () => {
  assert.equal(hopSpawnEnv({}, { humanMode: true }).HOPIT_JSON, '0')
  assert.equal(hopSpawnEnv({}, { humanMode: false }).HOPIT_JSON, '1')
  // Base env values survive.
  assert.equal(hopSpawnEnv({ PATH: '/usr/bin' }).PATH, '/usr/bin')
})

test('sync/refresh/service args target the codebase explicitly', () => {
  assert.deepEqual(syncArgs('lunarlog'), ['sync', '--codebase-id', 'lunarlog'])
  assert.deepEqual(refreshArgs('hopit'), ['refresh', '--codebase-id', 'hopit'])
  assert.deepEqual(serviceArgs('start', 'lunarlog'), ['service', 'start', '--codebase-id', 'lunarlog'])
})

test('service actions are allow-listed', () => {
  assert.throws(() => serviceArgs('run', 'hopit'), /Unsupported/)
  assert.throws(() => serviceArgs('rm -rf', 'hopit'), /Unsupported/)
})

test('add args carry source and optional codebase id', () => {
  assert.deepEqual(addArgs({ source: '/Users/robert/Projects/App' }), ['add', '--source', '/Users/robert/Projects/App'])
  assert.deepEqual(addArgs({ source: '/p', codebaseId: 'my-app' }), ['add', '--source', '/p', '--codebase-id', 'my-app'])
})

test('unsafe IPC values are rejected before they reach spawn', () => {
  assert.throws(() => syncArgs('a/b'), /Unsafe/)
  assert.throws(() => addArgs({ source: 'relative/path' }), /absolute/)
  assert.throws(() => addArgs({ source: '/ok', codebaseId: '..' }), /Unsafe/)
})

test('hydrate builds hydrate-file vs hydrate-path correctly', () => {
  assert.deepEqual(hydratePathArgs({ codebaseId: 'hopit', cloudPath: 'src/a.ts' }), [
    'workspace', 'hydrate-file', '--path', 'src/a.ts', '--codebase-id', 'hopit',
  ])
  assert.deepEqual(hydratePathArgs({ codebaseId: 'hopit', cloudPath: 'src', recursive: true }), [
    'workspace', 'hydrate-path', '--path', 'src', '--codebase-id', 'hopit', '--recursive',
  ])
  assert.deepEqual(hydratePathArgs({ codebaseId: 'hopit', cloudPath: 'src/a.ts', withSiblings: true }), [
    'workspace', 'hydrate-file', '--path', 'src/a.ts', '--codebase-id', 'hopit', '--with-siblings',
  ])
})

test('pin/unpin args', () => {
  assert.deepEqual(pinArgs({ codebaseId: 'hopit', cloudPath: 'docs/a.md', pinned: true }), [
    'workspace', 'pin', '--path', 'docs/a.md', '--codebase-id', 'hopit',
  ])
  assert.deepEqual(pinArgs({ codebaseId: 'hopit', cloudPath: 'docs/a.md', pinned: false })[1], 'unpin')
})

test('cloud paths must be workspace-relative and traversal-free', () => {
  assert.equal(assertSafeCloudPath('src/app/page.tsx'), 'src/app/page.tsx')
  assert.equal(assertSafeCloudPath('windows\\style\\path'), 'windows/style/path')
  assert.throws(() => assertSafeCloudPath('/etc/passwd'), /relative/)
  assert.throws(() => assertSafeCloudPath('../outside'), /traverse/)
  assert.throws(() => assertSafeCloudPath('a/../../b'), /traverse/)
  assert.throws(() => assertSafeCloudPath(''), /required/)
})

test('streamHop rejects (not hangs) when the hop binary is missing', async () => {
  await assert.rejects(
    () => streamHop('/nonexistent/hop-binary-xyz', ['status'], { env: process.env }),
    /ENOENT/,
  )
})

test('streamHop survives a child dying mid-stream without throwing or hanging', async () => {
  // Emit a large chunk then hard-kill self: exercises the buffer/close path and
  // the stdio 'error' listeners added for broken-pipe safety.
  const script = "process.stdout.write('x'.repeat(500000)); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1)"
  const lines = []
  const result = await streamHop(process.execPath, ['-e', script], {
    env: process.env,
    onLine: (line) => lines.push(line),
  })
  // Killed by signal -> code is null; the promise still resolves cleanly.
  assert.equal(result.code, null)
})
