import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { test } from 'node:test'
import { createDeviceKeyMaterial, wrapSymmetricKeyForDevice } from '@hopit/core/crypto'

import { reconcileApprovedProjects } from '../src/commands/add.js'
import { scanProjectCandidates } from '../src/commands/scan-projects.js'
import { authorizeDeviceWithBrowser } from '../src/commands/setup.js'

async function makeTree(spec) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-scan-'))
  for (const [relative, kind] of Object.entries(spec)) {
    const target = path.join(root, relative)
    if (kind === 'dir') {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '')
  }
  return root
}

function candidate(codebaseId, extra = {}) {
  return { codebaseId, codebaseName: codebaseId, source: `/tmp/${codebaseId}`, signals: [], ...extra }
}

function approvedEntry(codebaseId, requestedCodebaseId = codebaseId) {
  return { codebaseId, requestedCodebaseId, sessionId: `session_${codebaseId}`, sessionToken: `hst_${codebaseId}` }
}

test('scanProjectCandidates offers every top-level folder but only recommends ones with project signals', async () => {
  const root = await makeTree({
    'alpha/.git': 'dir',
    'beta/package.json': 'file',
    'gamma/notes.txt': 'file',
    'delta/Cargo.toml': 'file',
    'loose-file.txt': 'file',
  })

  const candidates = await scanProjectCandidates(root)
  assert.deepEqual(candidates.map((entry) => entry.name), ['alpha', 'beta', 'delta', 'gamma'])
  // gamma has no marker: still offered, just not pre-selected.
  assert.deepEqual(
    candidates.filter((entry) => entry.recommended).map((entry) => entry.name),
    ['alpha', 'beta', 'delta'],
  )
  assert.deepEqual(candidates.find((entry) => entry.name === 'alpha').signals, ['git'])
  assert.deepEqual(candidates.find((entry) => entry.name === 'gamma').signals, [])

  await fs.rm(root, { recursive: true, force: true })
})

test('scanProjectCandidates never recommends dependency and build output folders', async () => {
  const root = await makeTree({
    'node_modules/package.json': 'file',
    'target/Cargo.toml': 'file',
    'real-app/package.json': 'file',
  })

  const candidates = await scanProjectCandidates(root)
  // Listed (the user asked for every top-level folder) but never checked by default,
  // so "Select all" cannot sweep a vendored tree into the batch.
  assert.deepEqual(candidates.map((entry) => entry.name), ['node_modules', 'real-app', 'target'])
  assert.deepEqual(
    candidates.filter((entry) => entry.recommended).map((entry) => entry.name),
    ['real-app'],
  )

  await fs.rm(root, { recursive: true, force: true })
})

test('scanProjectCandidates hides hidden folders unless they carry a project signal', async () => {
  const root = await makeTree({
    '.cache/whatever.bin': 'file',
    '.dotfiles/.git': 'dir',
    'visible/readme.md': 'file',
  })

  const candidates = await scanProjectCandidates(root)
  assert.deepEqual(candidates.map((entry) => entry.name), ['.dotfiles', 'visible'])

  await fs.rm(root, { recursive: true, force: true })
})

test('reconcileApprovedProjects connects every approved project', () => {
  const candidates = [candidate('alpha'), candidate('beta')]
  const { connected, skipped } = reconcileApprovedProjects(candidates, [
    approvedEntry('alpha'),
    approvedEntry('beta'),
  ])

  assert.deepEqual(connected.map((item) => item.candidate.codebaseId), ['alpha', 'beta'])
  assert.deepEqual(skipped, [])
})

test('reconcileApprovedProjects treats a browser deselection as a skip, not a failure', () => {
  const candidates = [candidate('alpha'), candidate('beta'), candidate('gamma')]
  const { connected, skipped } = reconcileApprovedProjects(candidates, [approvedEntry('beta')])

  assert.deepEqual(connected.map((item) => item.candidate.codebaseId), ['beta'])
  assert.deepEqual(skipped.map((entry) => entry.codebaseId), ['alpha', 'gamma'])
})

test('reconcileApprovedProjects aborts when an approval resolved to a different project', () => {
  const candidates = [candidate('lunarlog'), candidate('beta')]
  assert.throws(
    () => reconcileApprovedProjects(candidates, [approvedEntry('hopit', 'lunarlog')]),
    /approved a different project than requested/,
  )
})

test('reconcileApprovedProjects names the primary project in the destructive case', () => {
  const previous = process.env.HOPIT_CODEBASE_ID
  process.env.HOPIT_CODEBASE_ID = 'hopit'
  try {
    assert.throws(
      () => reconcileApprovedProjects([candidate('lunarlog')], [approvedEntry('hopit', 'lunarlog')]),
      /destroy its managed workspace/,
    )
  } finally {
    if (previous === undefined) delete process.env.HOPIT_CODEBASE_ID
    else process.env.HOPIT_CODEBASE_ID = previous
  }
})

test('reconcileApprovedProjects aborts on a project that was never requested', () => {
  assert.throws(
    () => reconcileApprovedProjects([candidate('alpha')], [approvedEntry('surprise')]),
    /which this command did not request/,
  )
})

test('reconcileApprovedProjects aborts when nothing at all was approved', () => {
  assert.throws(
    () => reconcileApprovedProjects([candidate('alpha')], []),
    /no projects were approved/,
  )
})

test('authorizeDeviceWithBrowser requests and unwraps a batch of projects in one round trip', async () => {
  const keyring = createDeviceKeyMaterial({ deviceId: 'dev_batch' })
  const tokenContext = 'device-authorization:dau_batch:session-token'
  const wrapFor = (token) => wrapSymmetricKeyForDevice({
    key: Buffer.from(token, 'utf8'),
    recipientPublicKeyPem: keyring.encryption.publicKeyPem,
    context: tokenContext,
  })

  let requestedBody = null
  let createCalls = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && url.pathname === '/api/device-authorizations') {
      createCalls += 1
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        requestedBody = JSON.parse(raw)
        send(200, {
          ok: true,
          verificationUriComplete: 'https://hopit.dev/device?code=TEST',
          userCode: 'TEST-CODE',
          deviceCode: 'device_code_batch',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          intervalSeconds: 1,
        })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/device-authorizations') {
      send(200, {
        ok: true,
        status: 'approved',
        tokenContext,
        apiBaseUrl: 'https://agent-api.example.test',
        requesterId: 'user_batch',
        authorizationId: 'dau_batch',
        codebaseId: 'alpha',
        sessionId: 'session_alpha',
        wrappedSessionToken: wrapFor('hst_alpha'),
        codebases: [
          { codebaseId: 'alpha', requestedCodebaseId: 'alpha', sessionId: 'session_alpha', wrappedSessionToken: wrapFor('hst_alpha') },
          { codebaseId: 'beta', requestedCodebaseId: 'beta', sessionId: 'session_beta', wrappedSessionToken: wrapFor('hst_beta') },
        ],
      })
      return
    }
    send(404, { ok: false, error: { message: 'not found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const connection = await authorizeDeviceWithBrowser({
      keyring,
      authBaseUrl: `http://127.0.0.1:${server.address().port}`,
      openBrowser: false,
      requestedCodebases: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
    })

    // Two projects, ONE authorization: this is what stops the per-device rate
    // limiter from cutting a multi-project add off partway through.
    assert.equal(createCalls, 1)
    assert.deepEqual(requestedBody.requestedCodebases, [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ])
    assert.equal(connection.codebases.length, 2)
    assert.deepEqual(connection.codebases.map((entry) => entry.codebaseId), ['alpha', 'beta'])
    assert.deepEqual(connection.codebases.map((entry) => entry.sessionToken), ['hst_alpha', 'hst_beta'])
    // Scalar fields still describe the first project for single-project callers.
    assert.equal(connection.codebaseId, 'alpha')
    assert.equal(connection.sessionToken, 'hst_alpha')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('authorizeDeviceWithBrowser synthesizes a one-project batch from a pre-batch server response', async () => {
  const keyring = createDeviceKeyMaterial({ deviceId: 'dev_legacy' })
  const tokenContext = 'device-authorization:dau_legacy:session-token'

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && url.pathname === '/api/device-authorizations') {
      req.resume()
      send(200, {
        ok: true,
        verificationUriComplete: 'https://hopit.dev/device?code=TEST',
        userCode: 'TEST-CODE',
        deviceCode: 'device_code_legacy',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        intervalSeconds: 1,
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/device-authorizations') {
      // No `codebases` key at all, exactly like a server running older code.
      send(200, {
        ok: true,
        status: 'approved',
        tokenContext,
        apiBaseUrl: 'https://agent-api.example.test',
        requesterId: 'user_legacy',
        authorizationId: 'dau_legacy',
        codebaseId: 'solo',
        sessionId: 'session_solo',
        wrappedSessionToken: wrapSymmetricKeyForDevice({
          key: Buffer.from('hst_solo', 'utf8'),
          recipientPublicKeyPem: keyring.encryption.publicKeyPem,
          context: tokenContext,
        }),
      })
      return
    }
    send(404, { ok: false, error: { message: 'not found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const connection = await authorizeDeviceWithBrowser({
      keyring,
      authBaseUrl: `http://127.0.0.1:${server.address().port}`,
      openBrowser: false,
    })
    assert.equal(connection.codebases.length, 1)
    assert.equal(connection.codebases[0].codebaseId, 'solo')
    assert.equal(connection.codebases[0].sessionToken, 'hst_solo')
    assert.equal(connection.codebaseId, 'solo')
    assert.equal(connection.sessionToken, 'hst_solo')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
