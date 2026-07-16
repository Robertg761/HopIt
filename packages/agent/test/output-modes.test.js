// @ts-check
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

const ANSI = /\u001b\[/

async function makeSource() {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-output-src-'))
  await fs.writeFile(path.join(src, 'README.md'), 'hello\n')
  await fs.writeFile(path.join(src, 'a.txt'), 'a\n')
  await fs.writeFile(path.join(src, 'b.txt'), 'b\n')
  return src
}

async function runImport(extraEnv) {
  const src = await makeSource()
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-output-state-'))
  const args = [
    cliPath,
    'import-local',
    '--source', src,
    '--cloud', path.join(state, 'cloud.json'),
    '--workspace', path.join(state, 'ws'),
    '--journal', path.join(state, 'j.ndjson'),
    '--events', path.join(state, 'e.ndjson'),
    '--cloud-backend', 'local',
    '--allow-local-cloud',
    '--force',
  ]
  // Non-TTY by construction (execFile pipes stdio). A fresh env avoids inheriting
  // the suite-wide HOPIT_JSON=1 so we can exercise the human default explicitly.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    HOPIT_NO_ENV_FILE: '1',
    ...extraEnv,
  }
  return execFileAsync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', env })
}

test('human mode keeps stdout clean and prints a concise stderr summary', async () => {
  const { stdout, stderr } = await runImport({ HOPIT_JSON: '', NO_COLOR: '1' })

  // Raw per-event NDJSON must NOT reach stdout in human mode.
  assert.doesNotMatch(stdout, /local\.imported/)
  assert.doesNotMatch(stdout, /file\.hydrated/)
  assert.equal(stdout.trim(), '')

  // Concise human progress + summary go to stderr.
  assert.match(stderr, /Imported 3 files/)
  assert.match(stderr, /Workspace ready/)

  // Piped output: no carriage-return spinner frames, and NO_COLOR strips ANSI.
  assert.ok(!stdout.includes('\r'), 'stdout should not contain carriage returns when piped')
  assert.ok(!stderr.includes('\r'), 'stderr should not contain carriage returns when piped')
  assert.doesNotMatch(stderr, ANSI)
})

test('--json / HOPIT_JSON restores the exact raw event stream on stdout', async () => {
  const { stdout } = await runImport({ HOPIT_JSON: '1' })
  assert.match(stdout, /local\.imported \{/)
  assert.match(stdout, /file\.hydrated \{/)
  // Every raw event line is a parseable "<event> <json>" pair.
  const firstLine = stdout.split('\n').find((line) => line.startsWith('local.imported '))
  assert.ok(firstLine, 'expected a local.imported event line')
  const detail = JSON.parse(firstLine.slice('local.imported '.length))
  assert.equal(detail.files, 3)
})

test('the events journal records every event regardless of output mode', async () => {
  // Human mode still writes the full NDJSON events file for machine consumers.
  const src = await makeSource()
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-output-journal-'))
  const eventsPath = path.join(state, 'e.ndjson')
  await execFileAsync(
    process.execPath,
    [
      cliPath, 'import-local',
      '--source', src,
      '--cloud', path.join(state, 'cloud.json'),
      '--workspace', path.join(state, 'ws'),
      '--journal', path.join(state, 'j.ndjson'),
      '--events', eventsPath,
      '--cloud-backend', 'local', '--allow-local-cloud', '--force',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, HOPIT_NO_ENV_FILE: '1', HOPIT_JSON: '', NO_COLOR: '1' },
    },
  )
  const events = (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const names = events.map((e) => e.event)
  assert.ok(names.includes('local.imported'), 'events file should include local.imported')
  assert.ok(names.filter((n) => n === 'file.hydrated').length === 3, 'events file should include every file.hydrated')
})
