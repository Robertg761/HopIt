import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createDeviceKeyMaterial, wrapSymmetricKeyForDevice } from '@hopit/core/crypto'

import { authorizeDeviceWithBrowser } from '../src/commands/setup.js'

// Spin up a throwaway HTTP server whose per-request behavior is driven by
// `handler(req, res, url)`. Returns the base URL and a close() helper.
async function startFixture(handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    handler(req, res, url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function createResponseBody() {
  return {
    ok: true,
    verificationUriComplete: 'https://hopit.dev/devices/approve?code=TEST',
    userCode: 'TEST-CODE',
    deviceCode: 'device_code_fixture',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    // Minimum poll interval is clamped to 1s inside the flow.
    intervalSeconds: 1,
  }
}

function approvedResponseBody(keyring) {
  const tokenContext = 'device-session:dau_fixture'
  const wrappedSessionToken = wrapSymmetricKeyForDevice({
    key: Buffer.from('hst_fixture_session_token', 'utf8'),
    recipientPublicKeyPem: keyring.encryption.publicKeyPem,
    context: tokenContext,
  })
  return {
    ok: true,
    status: 'approved',
    tokenContext,
    wrappedSessionToken,
    apiBaseUrl: 'https://agent-api.example.test',
    codebaseId: 'my-project',
    requesterId: 'user_fixture',
    sessionId: 'session_fixture',
    authorizationId: 'dau_fixture',
  }
}

test('authorizeDeviceWithBrowser tolerates a dropped poll and completes on the next approved poll', async () => {
  const keyring = createDeviceKeyMaterial({ deviceId: 'dev_authorize_ok' })

  let createCalls = 0
  let pollCalls = 0
  const fixture = await startFixture((req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/device-authorizations') {
      createCalls += 1
      sendJson(res, 200, createResponseBody())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/device-authorizations') {
      pollCalls += 1
      // First poll: sever the connection mid-flight so the client sees a
      // transient `fetch failed`. The flow must keep waiting, not abort.
      if (pollCalls === 1) {
        req.destroy()
        return
      }
      sendJson(res, 200, approvedResponseBody(keyring))
      return
    }
    sendJson(res, 404, { ok: false, error: { message: 'not found' } })
  })

  try {
    const connection = await authorizeDeviceWithBrowser({
      keyring,
      authBaseUrl: fixture.baseUrl,
      openBrowser: false,
    })
    assert.equal(createCalls, 1)
    assert.ok(pollCalls >= 2, `expected at least two polls, saw ${pollCalls}`)
    assert.equal(connection.codebaseId, 'my-project')
    assert.equal(connection.requesterId, 'user_fixture')
    assert.equal(connection.sessionId, 'session_fixture')
    assert.equal(connection.sessionToken, 'hst_fixture_session_token')
    assert.equal(connection.apiBaseUrl, 'https://agent-api.example.test')
    assert.equal(connection.remotePushUrl, 'wss://agent-api.example.test/events')
    assert.equal(connection.authorizationId, 'dau_fixture')
  } finally {
    await fixture.close()
  }
})

test('authorizeDeviceWithBrowser stops retrying and throws on a 401 poll error body', async () => {
  const keyring = createDeviceKeyMaterial({ deviceId: 'dev_authorize_401' })

  let pollCalls = 0
  const fixture = await startFixture((req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/device-authorizations') {
      sendJson(res, 200, createResponseBody())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/device-authorizations') {
      pollCalls += 1
      sendJson(res, 401, { ok: false, error: { message: 'Device authorization token is invalid.' } })
      return
    }
    sendJson(res, 404, { ok: false, error: { message: 'not found' } })
  })

  try {
    await assert.rejects(
      () => authorizeDeviceWithBrowser({
        keyring,
        authBaseUrl: fixture.baseUrl,
        openBrowser: false,
      }),
      /Device authorization token is invalid\./,
    )
    // A hard 4xx must abort immediately, not keep polling until expiry.
    assert.equal(pollCalls, 1)
  } finally {
    await fixture.close()
  }
})

test('authorizeDeviceWithBrowser retries the create call through a transient 503', async () => {
  const keyring = createDeviceKeyMaterial({ deviceId: 'dev_authorize_create_retry' })

  let createCalls = 0
  const fixture = await startFixture((req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/device-authorizations') {
      createCalls += 1
      if (createCalls === 1) {
        sendJson(res, 503, { ok: false, error: { message: 'temporarily unavailable' } })
        return
      }
      sendJson(res, 200, createResponseBody())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/device-authorizations') {
      sendJson(res, 200, approvedResponseBody(keyring))
      return
    }
    sendJson(res, 404, { ok: false, error: { message: 'not found' } })
  })

  try {
    const connection = await authorizeDeviceWithBrowser({
      keyring,
      authBaseUrl: fixture.baseUrl,
      openBrowser: false,
    })
    assert.equal(createCalls, 2, 'expected the create call to retry once through the 503')
    assert.equal(connection.sessionToken, 'hst_fixture_session_token')
  } finally {
    await fixture.close()
  }
})
