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
  compareArgs,
  trailEpisodesArgs,
  trailSummariesProbeArgs,
  trailSummarizeArgs,
  migrateWorkspaceRootArgs,
  assertSafeRevision,
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

test('workspace root migration args carry an explicit root and selected projects', () => {
  assert.deepEqual(
    migrateWorkspaceRootArgs({ newRoot: '/Volumes/Work/HopIt', projectIds: ['hopit', 'lunarlog', 'hopit'] }),
    ['workspace', 'migrate-root', '--new-root', '/Volumes/Work/HopIt', '--projects', 'hopit,lunarlog'],
  )
  assert.deepEqual(
    migrateWorkspaceRootArgs({ newRoot: '/Volumes/Work/HopIt', projectIds: [] }),
    ['workspace', 'migrate-root', '--new-root', '/Volumes/Work/HopIt'],
  )
  assert.throws(() => migrateWorkspaceRootArgs({ newRoot: 'relative', projectIds: [] }), /absolute/)
  assert.throws(() => migrateWorkspaceRootArgs({ newRoot: '/safe', projectIds: ['../bad'] }), /Unsafe/)
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

test('compareArgs builds a directory compare targeting the codebase', () => {
  assert.deepEqual(compareArgs({ codebaseId: 'hopit', fromRevision: 4436, toRevision: 4437 }), [
    'compare', '--from', '4436', '--to', '4437', '--codebase-id', 'hopit',
  ])
})

test('compareArgs adds --path only for a single-file diff', () => {
  assert.deepEqual(compareArgs({ codebaseId: 'hopit', fromRevision: 1, toRevision: 3, cloudPath: 'src/a.ts' }), [
    'compare', '--from', '1', '--to', '3', '--codebase-id', 'hopit', '--path', 'src/a.ts',
  ])
  // An empty path is treated as a directory compare, not an empty --path token.
  assert.deepEqual(compareArgs({ codebaseId: 'hopit', fromRevision: 1, toRevision: 3, cloudPath: '' }), [
    'compare', '--from', '1', '--to', '3', '--codebase-id', 'hopit',
  ])
})

test('compareArgs coerces string revisions and normalizes the path', () => {
  assert.deepEqual(compareArgs({ codebaseId: 'hopit', fromRevision: '10', toRevision: '12', cloudPath: 'win\\path' }), [
    'compare', '--from', '10', '--to', '12', '--codebase-id', 'hopit', '--path', 'win/path',
  ])
})

test('compareArgs rejects injection and malformed revisions before spawn', () => {
  assert.throws(() => compareArgs({ codebaseId: 'a/b', fromRevision: 1, toRevision: 2 }), /Unsafe/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: '1 --exec', toRevision: 2 }), /Invalid --from/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: 1, toRevision: 'NaN' }), /Invalid --to/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: -1, toRevision: 2 }), /Invalid --from/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: 1.5, toRevision: 2 }), /Invalid --from/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: 1, toRevision: 2, cloudPath: '../escape' }), /traverse/)
  assert.throws(() => compareArgs({ codebaseId: 'hopit', fromRevision: 1, toRevision: 2, cloudPath: '/abs' }), /relative/)
})

test('trailEpisodesArgs targets the episodes subcommand with a validated codebase id', () => {
  assert.deepEqual(trailEpisodesArgs('hopit'), ['trail', 'episodes', '--codebase-id', 'hopit'])
  assert.throws(() => trailEpisodesArgs('../evil'), /codebase/i)
})

test('trailSummariesProbeArgs reads the setting via a bounded dry-run summarize', () => {
  assert.deepEqual(
    trailSummariesProbeArgs('hopit'),
    ['trail', 'summarize', '--dry-run', '--limit', '1', '--codebase-id', 'hopit'],
  )
  assert.throws(() => trailSummariesProbeArgs('a/b'), /codebase/i)
})

test('trailSummarizeArgs builds the real summarize run with a validated codebase id', () => {
  assert.deepEqual(trailSummarizeArgs('hopit'), ['trail', 'summarize', '--codebase-id', 'hopit'])
  assert.throws(() => trailSummarizeArgs('..'), /codebase/i)
})

test('assertSafeRevision accepts non-negative safe integers only', () => {
  assert.equal(assertSafeRevision(0), 0)
  assert.equal(assertSafeRevision('4437'), 4437)
  assert.throws(() => assertSafeRevision('', 'from'), /Invalid from/)
  assert.throws(() => assertSafeRevision(-5), /Invalid/)
  assert.throws(() => assertSafeRevision(Number.MAX_SAFE_INTEGER + 2), /Invalid/)
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
