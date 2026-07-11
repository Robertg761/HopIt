// @ts-check
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  buildMenuModel,
  handlerNameForId,
  isSetUp,
  menuOptionIds,
} from '../src/commands/interactive.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

const notSetUp = { envFilePath: null, codebases: [], serviceRunning: false }
const connected = {
  envFilePath: '/home/tester/.config/hopit/production.env',
  codebases: [{ id: 'hopit', name: 'hopit' }, { id: 'sidecar', name: 'sidecar' }],
  serviceRunning: false,
}

test('isSetUp is true when an env file exists or a codebase is connected', () => {
  assert.equal(isSetUp(notSetUp), false)
  assert.equal(isSetUp({ envFilePath: null, codebases: [{ id: 'x' }] }), true)
  assert.equal(isSetUp({ envFilePath: '/tmp/x.env', codebases: [] }), true)
})

test('an unconfigured device leads with guided setup and hides project actions', () => {
  const ids = menuOptionIds(notSetUp)
  assert.equal(ids[0], 'setup')
  assert.ok(ids.includes('help'))
  assert.ok(ids.includes('exit'))
  assert.ok(!ids.includes('add'))
  assert.ok(!ids.includes('sync'))
})

test('a connected device exposes the project actions', () => {
  const model = buildMenuModel(connected)
  const ids = model.options.map((o) => o.id)
  assert.equal(ids[0], 'add')
  for (const expected of ['add', 'status', 'sync', 'refresh', 'doctor', 'help', 'exit']) {
    assert.ok(ids.includes(expected), `expected menu to include ${expected}`)
  }
  assert.match(model.subtitle, /2 projects connected/)
})

test('the service option reflects the running state', () => {
  assert.ok(menuOptionIds({ ...connected, serviceRunning: false }).includes('service-start'))
  assert.ok(menuOptionIds({ ...connected, serviceRunning: true }).includes('service-stop'))
})

test('every menu option maps to a dispatch handler and carries an example command', () => {
  for (const state of [notSetUp, connected, { ...connected, serviceRunning: true }]) {
    for (const option of buildMenuModel(state).options) {
      assert.ok(handlerNameForId(option.id), `option ${option.id} must map to a handler`)
      if (option.id !== 'exit') {
        assert.ok(option.command, `option ${option.id} should show an equivalent command`)
      }
    }
  }
  assert.equal(handlerNameForId('add'), 'runAdd')
  assert.equal(handlerNameForId('sync'), 'syncOnce')
  assert.equal(handlerNameForId('doctor'), 'runDoctor')
  assert.equal(handlerNameForId('setup'), 'runSetup')
})

test('bare `hop` on a non-TTY prints help and never enters the menu', async () => {
  // execFile pipes stdio, so stdin/stdout are not TTYs. The command must return
  // promptly (printHelp) instead of blocking on interactive keypresses.
  const { stdout } = await execFileAsync(process.execPath, [cliPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOPIT_NO_ENV_FILE: '1' },
  })
  assert.match(stdout, /hop - HopIt local workspace agent/)
  assert.match(stdout, /Commands:/)
})
