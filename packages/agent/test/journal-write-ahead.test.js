// Write-ahead journaling across a cloud outage
// (`packages/agent/src/graph-cache.js`, `performSyncOnce`).
//
// GR-X1 scenario 5 pinned down that a hard outage produced *no journal entry
// at all*: `performSyncOnce` must read the cloud graph before it can plan,
// so the read failed and the writes survived only as files on disk waiting
// for GR-A4's startup diff-scan. That is recovery-on-restart, not a
// write-ahead journal.
//
// This suite covers the fix: successful reads snapshot the graph, an
// unreachable cloud plans against that snapshot and journals `pending`
// entries, and reconnecting commits them through the normal recovery path --
// including the case where the cloud moved underneath the snapshot, which
// must open a divergence rather than overwrite the newer revision.
//
// The discriminator between "unreachable" and "the server said no" is
// load-bearing and gets its own unit coverage: an auth or quota failure must
// keep failing loudly instead of quietly journaling against a stale graph.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { readNdjson } from '../src/io.js'
import { graphCachePathFor, isCloudUnreachableError, readCachedGraph } from '../src/graph-cache.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

// ---------------------------------------------------------------------------
// Unit: the unreachable/rejected discriminator
// ---------------------------------------------------------------------------

test('isCloudUnreachableError: transport failures are unreachable', () => {
  assert.equal(isCloudUnreachableError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })), true)
  assert.equal(isCloudUnreachableError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true)
  assert.equal(isCloudUnreachableError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })), true)
  assert.equal(isCloudUnreachableError(Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' })), true)

  // The shape Node actually produces: a bare TypeError wrapping the errno.
  const fetchFailure = new TypeError('fetch failed')
  fetchFailure.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  assert.equal(isCloudUnreachableError(fetchFailure), true)
  assert.equal(isCloudUnreachableError(new TypeError('fetch failed')), true, 'cause is not always populated')
})

test('isCloudUnreachableError: a server that answered and said no is NOT unreachable', () => {
  // These all mean a response arrived. Falling back to a cached graph here
  // would hide a real, non-transient problem behind a growing local backlog.
  assert.equal(isCloudUnreachableError(new Error('D1 query failed: Unauthorized')), false)
  assert.equal(isCloudUnreachableError(new Error('D1 query failed: quota exceeded')), false)
  assert.equal(isCloudUnreachableError(new Error('D1 statement failed: no such column: mirror_branch')), false)
  assert.equal(isCloudUnreachableError(new Error('base_revision_mismatch')), false)
  assert.equal(isCloudUnreachableError(Object.assign(new Error('missing'), { code: 'ENOENT' })), false)
  assert.equal(isCloudUnreachableError(null), false)
  assert.equal(isCloudUnreachableError(undefined), false)
})

test('isCloudUnreachableError: a cyclic cause chain terminates', () => {
  const a = new Error('a')
  const b = new Error('b')
  a.cause = b
  b.cause = a
  assert.equal(isCloudUnreachableError(a), false)
})

// ---------------------------------------------------------------------------
// End to end against a severable loopback D1 worker
// ---------------------------------------------------------------------------

async function startSeverableD1Server(t) {
  const { default: d1ApiWorker } = await import('../../../cloudflare/d1/api-worker.js')
  const db = new DatabaseSync(':memory:')
  const env = { HOPIT_D1_DB: d1Binding(db), HOPIT_D1_PROXY_TOKEN: 'token_test', HOPIT_D1_PROXY_LOG_REQUESTS: '0' }
  let severed = false
  const sockets = new Set()

  const server = createServer(async (request, response) => {
    if (severed) {
      request.socket.destroy()
      return
    }
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request)
      const workerResponse = await d1ApiWorker.fetch(
        new Request(`http://127.0.0.1${request.url ?? '/query'}`, { method: request.method, headers: request.headers, body }),
        env,
      )
      response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()))
      response.end(await workerResponse.text())
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        result: [{ success: false, results: [], error: error instanceof Error ? error.message : 'query failed' }],
      }))
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    db.close()
    server.close()
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    sever() {
      severed = true
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      severed = false
    },
  }
}

function d1Binding(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        bind(...params) {
          return {
            all() {
              const isSelect = sql.trim().toLowerCase().startsWith('select')
              const result = isSelect ? null : statement.run(...params)
              return { results: isSelect ? statement.all(...params) : [], meta: { changes: result?.changes ?? 0 } }
            },
          }
        },
      }
    },
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-wal-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

function deviceArgs(server, device) {
  return [
    '--cloud-backend', 'd1',
    '--codebase-id', 'hopit-core',
    '--d1-api-base-url', server.baseUrl,
    '--d1-account-id', 'account_test',
    '--d1-database-id', 'database_test',
    '--d1-api-token', 'token_test',
    '--workspace', device.workspace,
    '--journal', device.journal,
    '--events', device.events,
  ]
}

function makeDevice(root, name) {
  return {
    workspace: path.join(root, `${name}-workspace`),
    journal: path.join(root, `${name}-journal.ndjson`),
    events: path.join(root, `${name}-events.ndjson`),
  }
}

async function runCli(command, args) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function runCliAllowingFailure(command, args) {
  try {
    const { stdout, stderr } = await runCli(command, args)
    return { ok: true, stdout, stderr }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function writeWorkspaceFile(device, relativePath, content) {
  const target = path.join(device.workspace, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

test('a successful sync snapshots the cloud graph next to the journal', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'snapshot')
  const device = makeDevice(root, 'device-a')
  const args = deviceArgs(server, device)

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)
  await writeWorkspaceFile(device, 'src/a.ts', 'export const a = 1\n')
  await runCli('sync-once', args)

  // The snapshot is the graph as read at the *start* of a sync -- always a
  // state the server really was in, never a locally-mutated one. So the file
  // this sync just committed shows up in the snapshot the *next* sync takes.
  const afterFirst = await readCachedGraph({ journal: device.journal })
  assert.ok(afterFirst, 'a snapshot exists after a successful sync')
  assert.ok(Number.isInteger(afterFirst.revision), 'the snapshot carries the revision it was taken at')
  assert.equal('src/a.ts' in afterFirst.files, false, 'the snapshot predates this syncs own commit')

  await runCli('sync-once', args)
  const afterSecond = await readCachedGraph({ journal: device.journal })
  assert.ok(afterSecond.files['src/a.ts'], 'the next sync snapshots the committed state')
  assert.match(graphCachePathFor({ journal: device.journal }), /device-a-journal\.graph-cache\.json$/)
})

test('an unreachable cloud journals pending entries instead of failing to journal at all', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'offline-journal')
  const device = makeDevice(root, 'device-a')
  const args = deviceArgs(server, device)

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)
  await runCli('sync-once', args)

  server.sever()

  const offlineWrites = {
    'src/offline-1.ts': 'export const one = 1\n',
    'src/nested/offline-2.ts': 'export const two = 2\n',
  }
  for (const [relativePath, content] of Object.entries(offlineWrites)) {
    await writeWorkspaceFile(device, relativePath, content)
  }
  const attempt = await runCliAllowingFailure('sync-once', args)
  assert.equal(attempt.ok, true, 'the sync completes rather than throwing: there is a snapshot to plan against')

  const events = await readNdjson(device.events)
  assert.ok(events.some((event) => event.event === 'sync.cloud_unreachable'), 'the outage is reported')
  const pendingEvent = events.filter((event) => event.event === 'journal.write_ahead_pending').at(-1)
  assert.ok(pendingEvent, 'the write-ahead batch is reported')
  assert.equal(pendingEvent.detail.count, 2)

  // The whole point: entries exist, are well formed, and are pending.
  const journal = await readNdjson(device.journal)
  for (const relativePath of Object.keys(offlineWrites)) {
    const entry = journal.find((row) => row.path === relativePath)
    assert.ok(entry, `${relativePath} was journaled while the cloud was unreachable`)
    assert.equal(entry.status, 'pending')
    assert.ok(entry.hash, 'the entry carries a content hash')
    assert.ok(entry.scope, 'the entry carries a privacy scope')
  }

  // Nothing was acknowledged, because nothing could be.
  assert.equal(events.filter((event) => event.event === 'cloud.acknowledged').some((event) =>
    Object.keys(offlineWrites).includes(event.detail?.path)), false)

  const status = JSON.parse((await runCli('status', args)).stdout)
  assert.equal(status.journal.pendingCount, 2, 'the backlog is real and visible')
})

test('reconnecting commits the write-ahead backlog and converges', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'reconnect')
  const deviceA = makeDevice(root, 'device-a')
  const deviceB = makeDevice(root, 'device-b')
  const argsA = deviceArgs(server, deviceA)
  const argsB = deviceArgs(server, deviceB)

  await runCli('init', [...argsA, '--force'])
  await runCli('hydrate', argsA)
  await runCli('hydrate', argsB)
  await runCli('sync-once', argsA)

  server.sever()
  const content = 'export const survived = true\n'
  await writeWorkspaceFile(deviceA, 'src/survived.ts', content)
  await runCliAllowingFailure('sync-once', argsA)

  server.restore()
  const recovery = await runCli('recover', argsA)
  assert.match(recovery.stdout, /"acknowledged":1/, 'the pending entry committed on reconnect')
  assert.match(recovery.stdout, /"diverged":0/)

  const status = JSON.parse((await runCli('status', argsA)).stdout)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 0)

  await runCli('refresh', argsB)
  assert.equal(
    await fs.readFile(path.join(deviceB.workspace, 'src/survived.ts'), 'utf8'),
    content,
    'the write made it to the other device',
  )
})

test('a write-ahead entry whose path moved on the cloud opens a divergence, never an overwrite', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'stale-snapshot')
  const deviceA = makeDevice(root, 'device-a')
  const deviceB = makeDevice(root, 'device-b')
  const argsA = deviceArgs(server, deviceA)
  const argsB = deviceArgs(server, deviceB)

  await runCli('init', [...argsA, '--force'])
  await runCli('hydrate', argsA)
  await runCli('hydrate', argsB)
  await runCli('sync-once', argsA)

  // Device A goes dark and edits README.md against its snapshot.
  server.sever()
  const staleEdit = '# hopit-core\n\nDevice A, planned against a snapshot.\n'
  await writeWorkspaceFile(deviceA, 'README.md', staleEdit)
  await runCliAllowingFailure('sync-once', argsA)

  // Meanwhile the cloud moves the same path forward via device B.
  server.restore()
  const cloudWinner = '# hopit-core\n\nDevice B moved Main forward meanwhile.\n'
  await writeWorkspaceFile(deviceB, 'README.md', cloudWinner)
  await runCli('sync-once', argsB)

  // Device A reconnects. Its entry was planned against a revision the cloud
  // has since passed, so it must diverge rather than clobber device B.
  const recovery = await runCli('recover', argsA)
  assert.match(recovery.stdout, /"diverged":1/, 'the stale-snapshot entry is classified as a divergence')

  const statusA = JSON.parse((await runCli('status', argsA)).stdout)
  assert.equal(statusA.divergences.length, 1)
  assert.equal(statusA.divergences[0].path, 'README.md')

  // Both sides intact: device B's content still on the cloud, device A's
  // bytes still on its own disk.
  await runCli('refresh', argsB)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), cloudWinner)
  assert.equal(await fs.readFile(path.join(deviceA.workspace, 'README.md'), 'utf8'), staleEdit)
})

test('a cloud that answers with an error still fails loudly and journals nothing', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'auth-failure')
  const device = makeDevice(root, 'device-a')
  const args = deviceArgs(server, device)

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)
  await runCli('sync-once', args)

  const journalBefore = (await readNdjson(device.journal)).length

  // A reachable server that rejects the request: the wrong proxy token. This
  // must NOT be mistaken for an outage, or a real credential problem would
  // hide behind a silently growing local backlog.
  const badArgs = args.map((value) => (value === 'token_test' ? 'token_wrong' : value))
  await writeWorkspaceFile(device, 'src/rejected.ts', 'export const rejected = true\n')
  const attempt = await runCliAllowingFailure('sync-once', badArgs)

  assert.equal(attempt.ok, false, 'a rejected request fails the command')
  assert.equal(
    (await readNdjson(device.journal)).length,
    journalBefore,
    'nothing was journaled against the cached graph on an auth failure',
  )
  const events = await readNdjson(device.events)
  assert.equal(
    events.some((event) => event.event === 'sync.cloud_unreachable'),
    false,
    'a server that answered is never reported as unreachable',
  )
})

test('no snapshot yet means an unreachable cloud fails exactly as it did before', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'no-snapshot')
  const device = makeDevice(root, 'device-a')
  const args = deviceArgs(server, device)

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)

  // Remove the snapshot the hydrate/init path may have left, then sever: with
  // nothing to plan against there is no safe fallback, and the old behavior
  // (fail the sync) is the correct one.
  await fs.rm(graphCachePathFor({ journal: device.journal }), { force: true })
  server.sever()

  await writeWorkspaceFile(device, 'src/nope.ts', 'export const nope = true\n')
  const attempt = await runCliAllowingFailure('sync-once', args)
  assert.equal(attempt.ok, false, 'no snapshot, no write-ahead: the sync fails as before')
})
