import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { hashBuffer } from '../src/journal.js'
import { isTransientCloudError, withCloudFetchRetry } from '../src/cloud-retry.js'
import { materializeCloudEntry } from '../src/commands/sync.js'
import { hydrateFetchRetry } from '../src/commands/hydrate.js'

// Mirrors the live failure: undici raises `TypeError: fetch failed` with the
// real socket reset on `error.cause` (code UND_ERR_SOCKET).
function socketError() {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  return error
}

function httpError(status, message = 'http error') {
  const error = new Error(message)
  error.status = status
  return error
}

const noSleep = async () => {}

async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-hydrate-retry-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

function objectBackedEntry(body) {
  return {
    kind: 'file',
    contentStorage: 'object-blob',
    blobKey: 'codebases/demo/blobs/sha256/ab/objecthash',
    hash: hashBuffer(body),
    size: body.byteLength,
  }
}

test('isTransientCloudError retries sockets/5xx/429 but never 4xx auth failures', () => {
  assert.equal(isTransientCloudError(socketError()), true)
  assert.equal(isTransientCloudError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true)
  assert.equal(isTransientCloudError(httpError(500)), true)
  assert.equal(isTransientCloudError(httpError(503)), true)
  assert.equal(isTransientCloudError(httpError(429)), true)

  assert.equal(isTransientCloudError(httpError(401)), false)
  assert.equal(isTransientCloudError(httpError(403)), false)
  assert.equal(isTransientCloudError(httpError(400)), false)
  assert.equal(isTransientCloudError(new Error('validation: bad request')), false)
  assert.equal(isTransientCloudError(null), false)
})

test('withCloudFetchRetry recovers a transient fault and reports the recovery', async () => {
  let calls = 0
  const recoveries = []
  const value = await withCloudFetchRetry(
    async () => {
      calls += 1
      if (calls < 3) throw socketError()
      return 'ok'
    },
    {
      baseDelayMs: 1,
      sleep: noSleep,
      onRetrySuccess: (detail) => recoveries.push(detail),
    },
  )

  assert.equal(value, 'ok')
  assert.equal(calls, 3, 'it retries until the transient fault clears')
  assert.equal(recoveries.length, 1)
  assert.equal(recoveries[0].failures, 2)
  assert.equal(recoveries[0].attempt, 3)
})

test('withCloudFetchRetry fails immediately on a non-transient (401) error', async () => {
  let calls = 0
  let recovered = false
  await assert.rejects(
    () =>
      withCloudFetchRetry(
        async () => {
          calls += 1
          throw httpError(401, 'Unauthorized')
        },
        { baseDelayMs: 1, sleep: noSleep, onRetrySuccess: () => { recovered = true } },
      ),
    /Unauthorized/,
  )
  assert.equal(calls, 1, 'a 401 must not be retried')
  assert.equal(recovered, false)
})

test('withCloudFetchRetry throws the last error once transient attempts are exhausted', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withCloudFetchRetry(
        async () => {
          calls += 1
          throw socketError()
        },
        { attempts: 4, baseDelayMs: 1, sleep: noSleep },
      ),
    /fetch failed/,
  )
  assert.equal(calls, 4, 'it stops after the configured attempt budget')
})

test('materializeCloudEntry survives a transient blob fetch and journals cloud.fetch_recovered', async (t) => {
  const root = await makeTempRoot(t)
  const workspace = path.join(root, 'workspace')
  const options = { events: path.join(root, 'events.ndjson') }
  const body = Buffer.from('object-backed body\n')

  let readCalls = 0
  const cloudService = {
    async readBlob() {
      readCalls += 1
      if (readCalls < 3) throw socketError()
      return body
    },
  }

  await materializeCloudEntry(workspace, 'src/obj.txt', objectBackedEntry(body), cloudService, {
    fetchRetry: hydrateFetchRetry(options, 'src/obj.txt', { baseDelayMs: 1, sleep: noSleep }),
  })

  assert.equal(readCalls, 3, 'the dropped connection was retried, not fatal')
  assert.equal(await fs.readFile(path.join(workspace, 'src/obj.txt'), 'utf8'), 'object-backed body\n')

  const recovered = (await readNdjson(options.events)).findLast(
    (entry) => entry.event === 'cloud.fetch_recovered',
  )
  assert.ok(recovered, 'a recovery event is journaled so flakiness is observable')
  assert.equal(recovered.detail.path, 'src/obj.txt')
  assert.equal(recovered.detail.failures, 2)
  assert.equal(recovered.detail.code, 'UND_ERR_SOCKET')
})

test('materializeCloudEntry fails fast on a non-transient blob fetch error', async (t) => {
  const root = await makeTempRoot(t)
  const workspace = path.join(root, 'workspace')
  const options = { events: path.join(root, 'events.ndjson') }
  const body = Buffer.from('unauthorized body\n')

  let readCalls = 0
  const cloudService = {
    async readBlob() {
      readCalls += 1
      throw httpError(401, 'Unauthorized')
    },
  }

  await assert.rejects(
    () =>
      materializeCloudEntry(workspace, 'src/locked.txt', objectBackedEntry(body), cloudService, {
        fetchRetry: hydrateFetchRetry(options, 'src/locked.txt', { baseDelayMs: 1, sleep: noSleep }),
      }),
    /Unauthorized/,
  )

  assert.equal(readCalls, 1, 'a 401 aborts the fetch immediately')
  assert.equal(await fs.access(path.join(workspace, 'src/locked.txt')).then(() => true, () => false), false)

  const events = await readNdjson(options.events).catch(() => [])
  assert.equal(events.some((entry) => entry.event === 'cloud.fetch_recovered'), false)
})
