import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  assertReleaseAssetUrl,
  findPackageRoot,
  isReleaseNewer,
  parseReleaseVersion,
} from '../src/commands/update.js'

const execFileAsync = promisify(execFile)

async function writePackage(root, { version, createdAt, marker }) {
  await fs.mkdir(path.join(root, 'app'), { recursive: true })
  await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.writeFile(path.join(root, 'app', 'hop.mjs'), `// ${marker}\n`)
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    name: 'hop',
    version,
    createdAt,
    target: { key: 'linux-x64', platform: 'linux', arch: 'x64' },
    files: { app: 'app/hop.mjs' },
  }, null, 2))
}

test('parseReleaseVersion splits core and build id', () => {
  assert.deepEqual(parseReleaseVersion('0.0.1'), { core: [0, 0, 1], buildId: null })
  assert.deepEqual(parseReleaseVersion('1.2.3+abc.456'), { core: [1, 2, 3], buildId: 'abc.456' })
  assert.equal(parseReleaseVersion('not-a-version'), null)
  assert.equal(parseReleaseVersion(undefined), null)
})

test('isReleaseNewer prefers a higher core version', () => {
  assert.equal(isReleaseNewer({ version: '0.1.0' }, { version: '0.0.9' }), true)
  assert.equal(isReleaseNewer({ version: '0.0.9' }, { version: '0.1.0' }), false)
  assert.equal(isReleaseNewer({ version: '0.0.1' }, { version: '0.0.1' }), false)
})

test('isReleaseNewer will not overwrite a fresher local build with a stale release', () => {
  // The exact case that bit us: a locally-packaged build carries a plain core
  // version with no build id, while the published release has the same core plus
  // an older timestamp. Without the timestamp fallback this reads as "newer" and
  // silently downgrades the machine.
  const localBuild = { version: '0.0.1', builtAt: '2026-07-25T23:29:32.193Z' }
  const stalePublished = { version: '0.0.1+40e3e2f.20260717025950259', builtAt: '2026-07-17T02:59:50.259Z' }
  assert.equal(isReleaseNewer(stalePublished, localBuild), false)

  const freshPublished = { version: '0.0.1+abc.20260801000000000', builtAt: '2026-08-01T00:00:00.000Z' }
  assert.equal(isReleaseNewer(freshPublished, localBuild), true)
})

test('isReleaseNewer compares build ids when both carry one', () => {
  const older = { version: '0.0.1+aaa.20260717025950259', builtAt: '2026-07-17T02:59:50.259Z' }
  const newer = { version: '0.0.1+bbb.20260718025950259', builtAt: '2026-07-18T02:59:50.259Z' }
  assert.equal(isReleaseNewer(newer, older), true)
  assert.equal(isReleaseNewer(older, newer), false)
})

test('assertReleaseAssetUrl refuses to leave the release host', () => {
  assert.throws(
    () => assertReleaseAssetUrl('https://evil.example.com/releases/hop-linux-x64.tar.gz'),
    /must stay on the HopIt release host/,
  )
  assert.throws(
    () => assertReleaseAssetUrl('http://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev/x.tar.gz'),
    /must stay on the HopIt release host/,
  )
  assert.ok(assertReleaseAssetUrl(
    'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev/releases/1/hop-linux-x64.tar.gz',
  ))
})

test('findPackageRoot locates a packaged install and ignores a source checkout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-test-'))
  const pkg = path.join(root, 'hop-linux-x64')
  await writePackage(pkg, { version: '0.0.1', createdAt: '2026-07-20T00:00:00.000Z', marker: 'installed' })

  const found = await findPackageRoot(path.join(pkg, 'app'))
  assert.equal(found?.packageRoot, pkg)
  assert.equal(found?.manifest.target.key, 'linux-x64')

  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-nopkg-'))
  assert.equal(await findPackageRoot(bare), null)

  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(bare, { recursive: true, force: true })
})

test('runUpdate downloads, verifies, and swaps the package in place', async () => {
  const { runUpdate } = await import('../src/commands/update.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-e2e-'))
  const installed = path.join(root, 'hop-linux-x64')
  await writePackage(installed, { version: '0.0.1', createdAt: '2026-07-01T00:00:00.000Z', marker: 'OLD' })

  // Build a real tarball for the "published" newer build.
  const stage = path.join(root, 'stage')
  const newPkg = path.join(stage, 'hop-linux-x64')
  await writePackage(newPkg, { version: '0.0.2', createdAt: '2026-08-01T00:00:00.000Z', marker: 'NEW' })
  const archive = path.join(root, 'hop-linux-x64.tar.gz')
  await execFileAsync('tar', ['czf', archive, '-C', stage, 'hop-linux-x64'])
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex')

  const manifest = {
    schemaVersion: 2,
    version: '0.0.2',
    builtAt: '2026-08-01T00:00:00.000Z',
    targets: { 'linux-x64': { key: 'releases/0.0.2/hop-linux-x64.tar.gz', sha256, verified: true } },
  }

  // Intercept the two network reads rather than hitting the real release host.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.endsWith('/latest/manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (href.endsWith('hop-linux-x64.tar.gz')) {
      return new Response(await fs.readFile(archive), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const result = await runUpdate({ 'package-root': path.join(installed, 'app'), json: true })
    assert.equal(result.ok, true)
    assert.equal(result.state, 'updated')
    assert.equal(result.previousVersion, '0.0.1')
    assert.equal(result.sha256, sha256)

    // The installed package really was replaced, at the same path.
    const swapped = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'))
    assert.equal(swapped.version, '0.0.2')
    assert.match(await fs.readFile(path.join(installed, 'app', 'hop.mjs'), 'utf8'), /NEW/)

    // No backup directory left behind after a clean swap.
    const leftovers = (await fs.readdir(root)).filter((entry) => entry.includes('.previous-'))
    assert.deepEqual(leftovers, [])
  } finally {
    globalThis.fetch = realFetch
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runUpdate aborts on a checksum mismatch and leaves the install untouched', async () => {
  const { runUpdate } = await import('../src/commands/update.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-bad-'))
  const installed = path.join(root, 'hop-linux-x64')
  await writePackage(installed, { version: '0.0.1', createdAt: '2026-07-01T00:00:00.000Z', marker: 'OLD' })

  const stage = path.join(root, 'stage')
  await writePackage(path.join(stage, 'hop-linux-x64'), {
    version: '0.0.2', createdAt: '2026-08-01T00:00:00.000Z', marker: 'NEW',
  })
  const archive = path.join(root, 'hop-linux-x64.tar.gz')
  await execFileAsync('tar', ['czf', archive, '-C', stage, 'hop-linux-x64'])

  const manifest = {
    schemaVersion: 2,
    version: '0.0.2',
    builtAt: '2026-08-01T00:00:00.000Z',
    // Deliberately wrong digest, as a tampered or truncated download would give.
    targets: { 'linux-x64': { key: 'releases/0.0.2/hop-linux-x64.tar.gz', sha256: 'deadbeef'.repeat(8) } },
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.endsWith('/latest/manifest.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(await fs.readFile(archive), { status: 200 })
  }

  try {
    await assert.rejects(
      runUpdate({ 'package-root': path.join(installed, 'app'), json: true }),
      /checksum mismatch/,
    )
    // Still the original build, byte for byte.
    const kept = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'))
    assert.equal(kept.version, '0.0.1')
    assert.match(await fs.readFile(path.join(installed, 'app', 'hop.mjs'), 'utf8'), /OLD/)
  } finally {
    globalThis.fetch = realFetch
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runUpdate --check reports without changing anything', async () => {
  const { runUpdate } = await import('../src/commands/update.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-check-'))
  const installed = path.join(root, 'hop-linux-x64')
  await writePackage(installed, { version: '0.0.1', createdAt: '2026-07-01T00:00:00.000Z', marker: 'OLD' })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 2,
    version: '0.0.2',
    builtAt: '2026-08-01T00:00:00.000Z',
    targets: { 'linux-x64': { key: 'releases/0.0.2/hop-linux-x64.tar.gz', sha256: 'a'.repeat(64) } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  try {
    const result = await runUpdate({ 'package-root': path.join(installed, 'app'), check: true, json: true })
    assert.equal(result.state, 'available')
    assert.equal(result.latestVersion, '0.0.2')
    const kept = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'))
    assert.equal(kept.version, '0.0.1')
  } finally {
    globalThis.fetch = realFetch
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runUpdate refuses politely in a source checkout', async () => {
  const { runUpdate } = await import('../src/commands/update.js')
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-src-'))
  try {
    const result = await runUpdate({ 'package-root': bare, json: true })
    assert.equal(result.ok, false)
    assert.equal(result.state, 'not-packaged')
    assert.match(result.message, /packaged install/)
  } finally {
    await fs.rm(bare, { recursive: true, force: true })
  }
})

test('runUpdate stages beside the install, not in the system temp dir', async () => {
  // Regression: staging in os.tmpdir() made the final fs.rename cross filesystems
  // whenever /tmp is a tmpfs and the install lives on the root disk, which is the
  // default on most Linux boxes. It failed with EXDEV against a real install even
  // though every test passed, because the tests staged and installed both inside
  // /tmp. Assert the staging directory is a sibling of the package root.
  const { runUpdate } = await import('../src/commands/update.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-update-staging-'))
  const installed = path.join(root, 'hop-linux-x64')
  await writePackage(installed, { version: '0.0.1', createdAt: '2026-07-01T00:00:00.000Z', marker: 'OLD' })

  const stage = path.join(root, 'stage')
  await writePackage(path.join(stage, 'hop-linux-x64'), {
    version: '0.0.2', createdAt: '2026-08-01T00:00:00.000Z', marker: 'NEW',
  })
  const archive = path.join(root, 'hop-linux-x64.tar.gz')
  await execFileAsync('tar', ['czf', archive, '-C', stage, 'hop-linux-x64'])
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex')

  const seenStagingDirs = []
  const realMkdtemp = fs.mkdtemp.bind(fs)
  fs.mkdtemp = async (prefix, ...rest) => {
    const made = await realMkdtemp(prefix, ...rest)
    seenStagingDirs.push(made)
    return made
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.endsWith('/latest/manifest.json')) {
      return new Response(JSON.stringify({
        schemaVersion: 2,
        version: '0.0.2',
        builtAt: '2026-08-01T00:00:00.000Z',
        targets: { 'linux-x64': { key: 'releases/0.0.2/hop-linux-x64.tar.gz', sha256 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(await fs.readFile(archive), { status: 200 })
  }

  try {
    const result = await runUpdate({ 'package-root': path.join(installed, 'app'), json: true })
    assert.equal(result.state, 'updated')
    assert.equal(seenStagingDirs.length, 1, 'expected exactly one staging directory')
    assert.equal(
      path.dirname(seenStagingDirs[0]),
      path.dirname(installed),
      'staging must be a sibling of the package root so the swap stays on one filesystem',
    )
    // Specifically rules out the original bug: staging directly in the system
    // temp dir. (The fixture itself lives under /tmp, so a blanket "not under
    // tmpdir" check would be vacuous here.)
    assert.notEqual(path.dirname(seenStagingDirs[0]), os.tmpdir())
    // And it must not be left behind.
    assert.equal((await fs.readdir(root)).some((e) => e.startsWith('.hopit-update-')), false)
  } finally {
    fs.mkdtemp = realMkdtemp
    globalThis.fetch = realFetch
    await fs.rm(root, { recursive: true, force: true })
  }
})
