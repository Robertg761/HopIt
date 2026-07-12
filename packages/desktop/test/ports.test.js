import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveServicePort, stableStringHash, statusUrlForCodebase } from '../src/lib/ports.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

test('default codebase keeps the historical base port', () => {
  assert.equal(deriveServicePort('hopit'), 4785)
  assert.equal(deriveServicePort(null), 4785)
  assert.equal(deriveServicePort(undefined), 4785)
})

test('non-default codebases land in [4786, 5785]', () => {
  for (const id of ['lunarlog', 'a', 'some-very-long-codebase-id', 'Projects']) {
    const port = deriveServicePort(id)
    assert.ok(port >= 4786 && port <= 5785, `${id} -> ${port}`)
  }
})

test('derivation is stable', () => {
  assert.equal(deriveServicePort('lunarlog'), deriveServicePort('lunarlog'))
})

test('derivation matches the agent implementation exactly', async () => {
  // Import the real agent module and compare across a spread of ids. This is
  // the lockstep guarantee the reimplementation comment promises.
  const agentOptionsPath = path.resolve(__dirname, '..', '..', 'agent', 'src', 'options.js')
  const agent = await import(agentOptionsPath)
  for (const id of ['hopit', 'lunarlog', 'Projects', 'token-addicts-anonymous', 'x', 'UPPER-case.id_1']) {
    assert.equal(deriveServicePort(id), agent.deriveServicePort(id), `port mismatch for ${id}`)
    assert.equal(stableStringHash(id), agent.stableStringHash(id), `hash mismatch for ${id}`)
  }
})

test('status URL targets loopback with the derived port', () => {
  assert.equal(statusUrlForCodebase('hopit'), 'http://127.0.0.1:4785/status')
  assert.equal(statusUrlForCodebase('lunarlog'), `http://127.0.0.1:${deriveServicePort('lunarlog')}/status`)
})

// createRequire kept for parity with other test files that need JSON fixtures.
void require
