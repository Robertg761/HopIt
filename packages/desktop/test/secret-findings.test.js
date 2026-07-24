import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSecretFindings, openSecretFindings, secretFindingId } from '../src/lib/secret-findings.js'

test('secretFindingId prefers the event id, falls back to path+at', () => {
  assert.equal(secretFindingId({ id: 'evt-1', at: '2026-07-24T10:00:00Z', detail: { path: 'a.env' } }), 'evt-1')
  assert.equal(
    secretFindingId({ at: '2026-07-24T10:00:00Z', detail: { path: 'a.env' } }),
    'a.env::2026-07-24T10:00:00Z',
  )
  assert.equal(secretFindingId({}), 'unknown::unknown')
})

test('deriveSecretFindings maps recentSuspected newest-first with a rotate-not-redact message', () => {
  const findings = deriveSecretFindings(
    [
      { at: '2026-07-24T10:00:00Z', detail: { path: 'a.env', findingCount: 1 } },
      { at: '2026-07-24T10:05:00Z', detail: { path: 'b.env', findingCount: 3 } },
    ],
    { codebaseId: 'hopit' },
  )

  assert.equal(findings.length, 2)
  assert.equal(findings[0].path, 'b.env')
  assert.equal(findings[0].codebaseId, 'hopit')
  assert.equal(findings[0].message, 'Possible secret in b.env')
  assert.match(findings[0].guidance, /rotate/i)
  assert.doesNotMatch(findings[0].guidance, /redact it\./i)
  assert.equal(findings[1].path, 'a.env')
})

test('deriveSecretFindings tolerates a missing path', () => {
  const [finding] = deriveSecretFindings([{ at: '2026-07-24T10:00:00Z', detail: {} }])
  assert.equal(finding.path, null)
  assert.equal(finding.message, 'Possible secret found')
})

test('deriveSecretFindings is empty for a non-array input', () => {
  assert.deepEqual(deriveSecretFindings(undefined), [])
  assert.deepEqual(deriveSecretFindings(null), [])
})

test('openSecretFindings filters out dismissed ids and tolerates a missing set', () => {
  const findings = deriveSecretFindings([
    { id: 'evt-1', at: '2026-07-24T10:00:00Z', detail: { path: 'a.env' } },
    { id: 'evt-2', at: '2026-07-24T10:05:00Z', detail: { path: 'b.env' } },
  ])

  assert.deepEqual(openSecretFindings(findings, new Set(['evt-2'])).map((f) => f.id), ['evt-1'])
  assert.deepEqual(openSecretFindings(findings, undefined).map((f) => f.id), ['evt-2', 'evt-1'])
  assert.deepEqual(openSecretFindings(findings, new Set(['evt-1', 'evt-2'])), [])
})
