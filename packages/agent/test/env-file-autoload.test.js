// @ts-check
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  applyEnvPairs,
  autoloadEnvFile,
  expandShellValue,
  parseEnvFile,
  resolveEnvFilePath,
} from '../src/env-file.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function tempEnvFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-envfile-'))
  const file = path.join(dir, 'production.env')
  await fs.writeFile(file, content, 'utf8')
  return { dir, file }
}

test('parseEnvFile handles the supported sh subset', () => {
  const base = { HOME: '/home/tester' }
  const content = [
    '# a comment',
    '',
    'HOPIT_PROFILE=production',
    'HOPIT_CODEBASE_ID=hopit',
    'export HOPIT_REMOTE_PULL=1',
    'HOPIT_DEVICE_NAME="Tester Mac"',
    'HOPIT_WORKSPACE_ROOT="$HOME/HopIt Workspaces"',
    'HOPIT_BACKUP_ROOT=$HOME/HopIt-Backups',
    "HOPIT_LITERAL='$HOME stays literal'",
    'HOPIT_STATE=${XDG_STATE_HOME:-$HOME/.local/state}/hopit',
    'HOPIT_INLINE=value # trailing comment',
  ].join('\n')

  const pairs = parseEnvFile(content, base)
  const map = Object.fromEntries(pairs)
  assert.equal(map.HOPIT_PROFILE, 'production')
  assert.equal(map.HOPIT_CODEBASE_ID, 'hopit')
  assert.equal(map.HOPIT_REMOTE_PULL, '1')
  assert.equal(map.HOPIT_DEVICE_NAME, 'Tester Mac')
  assert.equal(map.HOPIT_WORKSPACE_ROOT, '/home/tester/HopIt Workspaces')
  assert.equal(map.HOPIT_BACKUP_ROOT, '/home/tester/HopIt-Backups')
  assert.equal(map.HOPIT_LITERAL, '$HOME stays literal')
  assert.equal(map.HOPIT_STATE, '/home/tester/.local/state/hopit')
  assert.equal(map.HOPIT_INLINE, 'value')
})

test('expandShellValue resolves ${VAR:-default} and honors set values', () => {
  assert.equal(expandShellValue('${FOO:-bar}', {}), 'bar')
  assert.equal(expandShellValue('${FOO:-bar}', { FOO: 'baz' }), 'baz')
  assert.equal(expandShellValue('$A/$B', { A: '1', B: '2' }), '1/2')
})

test('applyEnvPairs never overrides an existing environment variable', () => {
  const env = { HOPIT_CODEBASE_ID: 'from-shell' }
  const applied = applyEnvPairs(
    [['HOPIT_CODEBASE_ID', 'from-file'], ['HOPIT_PROFILE', 'production']],
    env,
  )
  assert.equal(env.HOPIT_CODEBASE_ID, 'from-shell') // explicit env wins
  assert.equal(env.HOPIT_PROFILE, 'production') // missing var is filled
  assert.deepEqual(applied, ['HOPIT_PROFILE'])
})

test('resolveEnvFilePath honors the escape hatch and $HOPIT_ENV_FILE', async () => {
  const { file } = await tempEnvFile('HOPIT_PROFILE=production\n')
  assert.equal(resolveEnvFilePath({ HOPIT_ENV_FILE: file }), file)
  assert.equal(resolveEnvFilePath({ HOPIT_ENV_FILE: file, HOPIT_NO_ENV_FILE: '1' }), null)
  assert.equal(resolveEnvFilePath({ HOPIT_ENV_FILE: '/no/such/hopit.env' }), null)
})

test('autoloadEnvFile is a silent no-op when the file is missing', () => {
  const env = { HOPIT_ENV_FILE: '/no/such/hopit.env' }
  const result = autoloadEnvFile(env)
  assert.equal(result.loaded, false)
  assert.deepEqual(result.applied, [])
})

test('autoloadEnvFile loads the file without clobbering existing env', async () => {
  const { file } = await tempEnvFile('HOPIT_PROFILE=production\nHOPIT_CODEBASE_ID=from-file\n')
  const env = { HOPIT_ENV_FILE: file, HOPIT_CODEBASE_ID: 'from-shell' }
  const result = autoloadEnvFile(env)
  assert.equal(result.loaded, true)
  assert.equal(env.HOPIT_PROFILE, 'production')
  assert.equal(env.HOPIT_CODEBASE_ID, 'from-shell')
})

// Integration: the CLI autoloads the env file early enough that option resolution
// (profile + codebase defaulting) sees HOPIT_PROFILE=production without --profile.
async function resolveViaCli(env) {
  const script = [
    "import { autoloadEnvFile } from './packages/agent/src/env-file.js'",
    "import { parseOptions } from './packages/agent/src/options.js'",
    'autoloadEnvFile()',
    'const o = parseOptions([])',
    "process.stdout.write(JSON.stringify({ profile: o.profile, codebase: o['codebase-id'] }))",
  ].join('\n')
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  })
  return JSON.parse(stdout)
}

test('profile defaults to production from the autoloaded env file', async () => {
  const { file } = await tempEnvFile('HOPIT_PROFILE=production\nHOPIT_CODEBASE_ID=from-file\n')
  const resolved = await resolveViaCli({ HOPIT_ENV_FILE: file })
  assert.equal(resolved.profile, 'production')
  assert.equal(resolved.codebase, 'from-file')
})

test('explicit env overrides the file, and the escape hatch disables autoload', async () => {
  const { file } = await tempEnvFile('HOPIT_PROFILE=production\nHOPIT_CODEBASE_ID=from-file\n')
  const overridden = await resolveViaCli({ HOPIT_ENV_FILE: file, HOPIT_CODEBASE_ID: 'from-shell' })
  assert.equal(overridden.profile, 'production')
  assert.equal(overridden.codebase, 'from-shell')

  const disabled = await resolveViaCli({ HOPIT_ENV_FILE: file, HOPIT_NO_ENV_FILE: '1' })
  assert.equal(disabled.profile, 'development')
})
