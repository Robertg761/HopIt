import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runDoctor } from '../src/commands/export.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'

async function makeState(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-doctor-identity-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = {
    quiet: true,
    profile: 'development',
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return options
}

// Runs runDoctor with a clean environment (no ambient requester/session identity)
// and returns the parsed doctor JSON payload plus the collected checks.
async function runDoctorCaptured(options) {
  const envKeys = ['HOPIT_REQUESTER_ID', 'HOPIT_SESSION_ID', 'HOPIT_AGENT_SESSION_TOKEN']
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const savedExitCode = process.exitCode
  const savedLog = console.log
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))

  try {
    await runDoctor(options)
  } finally {
    console.log = savedLog
    process.exitCode = savedExitCode
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const payload = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .findLast((value) => value && Array.isArray(value.checks))
  assert.ok(payload, 'doctor should print a JSON payload with checks')
  return payload
}

function requesterCheck(payload) {
  return payload.checks.find((check) => check.name === 'requester-identity')
}

test('doctor warns when a session id is configured but no requester id is set', async (t) => {
  const options = await makeState(t)
  const payload = await runDoctorCaptured({ ...options, 'session-id': 'session_guest_device' })
  const check = requesterCheck(payload)
  assert.ok(check, 'requester-identity check must be present')
  assert.equal(check.ok, false)
  assert.match(check.detail, /guest/i)
  assert.match(check.detail, /HOPIT_REQUESTER_ID/)
})

test('doctor stays quiet about requester identity when a requester id is configured', async (t) => {
  const options = await makeState(t)
  const payload = await runDoctorCaptured({
    ...options,
    'session-id': 'session_guest_device',
    'requester-id': 'user_demo_owner',
  })
  const check = requesterCheck(payload)
  assert.ok(check)
  assert.equal(check.ok, true)
})

test('doctor stays quiet about requester identity when no session identity is configured', async (t) => {
  const options = await makeState(t)
  const payload = await runDoctorCaptured({ ...options })
  const check = requesterCheck(payload)
  assert.ok(check)
  assert.equal(check.ok, true)
})
