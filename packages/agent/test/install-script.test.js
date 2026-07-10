import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..')
const scriptPath = path.join(repoRoot, 'public', 'install.sh')
const script = readFileSync(scriptPath, 'utf8')

test('install.sh is valid POSIX sh (sh -n)', () => {
  const result = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, `sh -n failed: ${result.stderr || result.stdout}`)
})

test('install.sh targets the public release channel base URL', () => {
  assert.ok(
    script.includes('https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'),
    'expected default release base URL',
  )
  assert.ok(script.includes('hop-${TARGET}.tar.gz'), 'expected per-target archive name')
})

test('install.sh detects both supported platforms and rejects Windows', () => {
  assert.ok(script.includes('Darwin) PLATFORM="darwin"'), 'expected Darwin branch')
  assert.ok(script.includes('Linux) PLATFORM="linux"'), 'expected Linux branch')
  assert.ok(script.includes('arm64 | aarch64) ARCH="arm64"'), 'expected arm64 branch')
  assert.ok(script.includes('x86_64 | amd64) ARCH="x64"'), 'expected x64 branch')
  assert.ok(/Windows is not supported yet/.test(script), 'expected Windows rejection message')
})

test('install.sh verifies the checksum before installing', () => {
  assert.ok(script.includes('shasum -a 256 -c'), 'expected shasum verification')
  assert.ok(script.includes('sha256sum -c'), 'expected sha256sum verification fallback')
})

test('install.sh finishes by pointing at hop setup', () => {
  assert.ok(script.includes("run 'hop setup'"), 'expected hop setup next-step guidance')
})
