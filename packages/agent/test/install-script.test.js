import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
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
  assert.ok(script.includes('${BASE}/${CHANNEL}/manifest.json'), 'expected channel manifest lookup')
  assert.ok(script.includes('releases/${VERSION}'), 'expected immutable release resolution')
})

test('install.sh detects both supported platforms and rejects Windows', () => {
  assert.ok(script.includes('Darwin) PLATFORM="darwin"'), 'expected Darwin branch')
  assert.ok(script.includes('Linux) PLATFORM="linux"'), 'expected Linux branch')
  assert.ok(script.includes('arm64 | aarch64) ARCH="arm64"'), 'expected arm64 branch')
  assert.ok(script.includes('x86_64 | amd64) ARCH="x64"'), 'expected x64 branch')
  assert.ok(/Windows is not supported yet/.test(script), 'expected Windows rejection message')
})

test('install.sh verifies the checksum before installing', () => {
  assert.ok(script.includes('shasum -a 256 "$ARCHIVE_PATH"'), 'expected direct shasum verification')
  assert.ok(script.includes('sha256sum "$ARCHIVE_PATH"'), 'expected direct sha256sum verification fallback')
  assert.ok(script.includes('$2 == archive'), 'expected exact archive-name validation')
  assert.ok(script.includes('ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM'), 'expected direct digest comparison')
  assert.ok(script.includes('need shasum or sha256sum'), 'expected install to fail closed without a checksum tool')
  assert.equal(script.includes('skipping checksum verification'), false)
})

test('install.sh exits on termination signals before EXIT cleanup', () => {
  assert.ok(script.includes("trap cleanup EXIT"), 'expected one cleanup trap')
  assert.ok(script.includes("trap 'exit 129' HUP"), 'expected HUP to terminate')
  assert.ok(script.includes("trap 'exit 130' INT"), 'expected INT to terminate')
  assert.ok(script.includes("trap 'exit 143' TERM"), 'expected TERM to terminate')
  assert.equal(script.includes('trap cleanup EXIT INT TERM'), false)
})

test('install.sh smoke-tests the downloaded runtime before replacing the current install', () => {
  const smokeIndex = script.indexOf('"$PACKAGE_SRC/bin/hop" help')
  const replaceIndex = script.indexOf('mv "$PACKAGE_SRC" "$RUNTIME_STAGE"')
  assert.ok(smokeIndex > 0, 'expected downloaded runtime smoke test')
  assert.ok(replaceIndex > smokeIndex, 'expected smoke test before runtime replacement')
})

test('install.sh serializes installers and atomically activates a versioned runtime', () => {
  assert.ok(script.includes('INSTALL_DIR/.install-lock'), 'expected an installer lock')
  assert.ok(script.includes('RUNTIMES_DIR/$VERSION'), 'expected immutable versioned runtime directories')
  assert.ok(script.includes('LAUNCHER_STAGE="$BIN_DIR/.hop.new.$$"'), 'expected a staged launcher')
  assert.ok(script.includes('mv -f "$LAUNCHER_STAGE" "$LINK"'), 'expected atomic launcher activation')
  assert.equal(script.includes('rm -f "$LINK"'), false, 'must not remove the working launcher before activation')
})

test('install.sh finishes by pointing at hop setup', () => {
  assert.ok(script.includes("run 'hop setup'"), 'expected hop setup next-step guidance')
})

test('install.sh resolves a channel manifest and installs one immutable release', async (t) => {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!platform || !arch) return t.skip('installer integration test requires a supported host')

  const target = `${platform}-${arch}`
  const version = '0.0.1+installer-test'
  const archiveName = `hop-${target}.tar.gz`
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-install-channel-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const packageRoot = path.join(root, 'package', `hop-${target}`)
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true })
  await fs.mkdir(path.join(packageRoot, 'runtime'), { recursive: true })
  await fs.writeFile(
    path.join(packageRoot, 'bin', 'hop'),
    '#!/bin/sh\n[ "${1:-}" = "help" ] && { echo "HopIt test runtime"; exit 0; }\necho "HopIt test runtime"\n',
    { mode: 0o755 },
  )
  await fs.writeFile(path.join(packageRoot, 'runtime', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const releaseRoot = path.join(root, 'releases', version)
  await fs.mkdir(releaseRoot, { recursive: true })
  const archivePath = path.join(releaseRoot, archiveName)
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', path.join(root, 'package'), `hop-${target}`], {
    encoding: 'utf8',
  })
  assert.equal(tar.status, 0, tar.stderr || tar.stdout)
  const checksum = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex')
  await fs.writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`, 'utf8')

  const manifest = {
    schemaVersion: 2,
    version,
    gitSha: 'installer-test',
    builtAt: new Date(0).toISOString(),
    targets: {
      [target]: {
        key: `releases/${version}/${archiveName}`,
        checksumKey: `releases/${version}/${archiveName}.sha256`,
        sha256: checksum,
      },
    },
  }
  await fs.mkdir(path.join(root, 'latest'), { recursive: true })
  await fs.writeFile(path.join(root, 'latest', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const server = createServer(async (request, response) => {
    try {
      const relativePath = new URL(request.url, 'http://localhost').pathname.replace(/^\/+/, '')
      const body = await fs.readFile(path.join(root, relativePath))
      response.writeHead(200)
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const home = path.join(root, 'home')
  await fs.mkdir(home, { recursive: true })
  const result = await runProcess('sh', [scriptPath], {
    ...process.env,
    HOME: home,
    HOPIT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
  })
  assert.equal(result.code, 0, result.stderr || result.stdout)
  assert.match(result.stderr, new RegExp(`Installing HopIt ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(await fs.readFile(path.join(home, '.local', 'bin', 'hop'), 'utf8').then((body) => body.includes(`/runtimes/${version}/bin/hop`)), true)
  assert.equal(await fs.stat(path.join(home, '.hopit', 'runtimes', version, 'bin', 'hop')).then((entry) => entry.mode & 0o111 ? true : false), true)

  const launcherBeforeLockedRetry = await fs.readFile(path.join(home, '.local', 'bin', 'hop'), 'utf8')
  const lockDir = path.join(home, '.hopit', '.install-lock')
  await fs.mkdir(lockDir)
  await fs.writeFile(path.join(lockDir, 'pid'), `${process.pid}\n`, 'utf8')
  const lockedRetry = await runProcess('sh', [scriptPath], {
    ...process.env,
    HOME: home,
    HOPIT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
  })
  assert.notEqual(lockedRetry.code, 0)
  assert.match(lockedRetry.stderr, /another HopIt installer is already running/)
  assert.equal(await fs.readFile(path.join(home, '.local', 'bin', 'hop'), 'utf8'), launcherBeforeLockedRetry)
  await fs.rm(lockDir, { recursive: true, force: true })

  await fs.writeFile(`${archivePath}.sha256`, `${checksum}  another-archive.tar.gz\n`, 'utf8')
  const malformedHome = path.join(root, 'malformed-home')
  await fs.mkdir(malformedHome)
  const malformedSidecar = await runProcess('sh', [scriptPath], {
    ...process.env,
    HOME: malformedHome,
    HOPIT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
  })
  assert.notEqual(malformedSidecar.code, 0)
  assert.match(malformedSidecar.stderr, /checksum sidecar is malformed or names the wrong archive/)
  await assert.rejects(() => fs.stat(path.join(malformedHome, '.local', 'bin', 'hop')), { code: 'ENOENT' })
})

function runProcess(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
