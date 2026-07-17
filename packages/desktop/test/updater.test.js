import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  currentAppBundlePath,
  createDesktopUpdater,
  downloadVerifiedArchive,
  isReleaseNewer,
  parseUpdateManifest,
} from '../src/lib/updater.js'

const require = createRequire(import.meta.url)
const { installStagedUpdate } = require('../src/lib/update-helper.cjs')

function manifest(version = '0.0.1+abc1234.20260717020000000', bytes = Buffer.from('update archive')) {
  return {
    schemaVersion: 2,
    version,
    gitSha: 'abc1234',
    builtAt: '2026-07-17T02:00:00.000Z',
    downloads: {
      macos: {
        signed: false,
        notarized: false,
        update: {
          key: `releases/${version}/HopIt-macOS.zip`,
          checksumKey: `releases/${version}/HopIt-macOS.zip.sha256`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          verified: true,
          format: 'zip',
        },
      },
    },
  }
}

test('update manifests are pinned to a verified immutable HopIt Mac archive', () => {
  const parsed = parseUpdateManifest(manifest())
  assert.equal(parsed.url, 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev/releases/0.0.1+abc1234.20260717020000000/HopIt-macOS.zip')
  assert.throws(() => parseUpdateManifest({ ...manifest(), schemaVersion: 1 }), /schema/)
  const wrongKey = manifest()
  wrongKey.downloads.macos.update.key = 'releases/other/NotHopIt.zip'
  assert.throws(() => parseUpdateManifest(wrongKey), /expected immutable/)
  const unverified = manifest()
  unverified.downloads.macos.update.verified = false
  assert.throws(() => parseUpdateManifest(unverified), /not verified/)
})

test('release comparison uses version core then HopIt build timestamps', () => {
  assert.equal(isReleaseNewer(
    { version: '0.0.1+new.20260717020000000' },
    { version: '0.0.1+old.20260717010000000' },
  ), true)
  assert.equal(isReleaseNewer(
    { version: '0.0.1+old.20260717010000000' },
    { version: '0.0.1+new.20260717020000000' },
  ), false)
  assert.equal(isReleaseNewer({ version: '0.1.0+new' }, { version: '0.0.9+old' }), true)
  assert.equal(isReleaseNewer({ version: '0.0.1+same' }, { version: '0.0.1+same' }), false)
})

test('update checks surface an available release without downloading it', async () => {
  const states = []
  const updater = createDesktopUpdater({
    isPackaged: true,
    platform: 'darwin',
    current: { version: '0.0.1+old.20260717010000000', builtAt: '2026-07-17T01:00:00.000Z' },
    userDataPath: '/tmp/unused',
    executablePath: '/Applications/HopIt.app/Contents/MacOS/HopIt',
    fetchFn: async () => new Response(JSON.stringify(manifest()), { status: 200 }),
    onState: (state) => states.push(state.state),
  })
  const state = await updater.check()
  assert.equal(state.state, 'available')
  assert.equal(state.latestVersion, manifest().version)
  assert.deepEqual(states, ['checking', 'available'])
})

test('verified downloader writes exact bytes and rejects checksum or size mismatches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-updater-download-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('verified HopIt update')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const fetchFn = async () => new Response(bytes, { status: 200 })
  const destination = path.join(root, 'HopIt-macOS.zip')
  await downloadVerifiedArchive({ url: 'https://example.invalid/update', destination, expectedSha256: sha256, expectedSize: bytes.length, fetchFn })
  assert.deepEqual(await fs.readFile(destination), bytes)
  await assert.rejects(
    downloadVerifiedArchive({ url: 'https://example.invalid/update', destination: path.join(root, 'bad.zip'), expectedSha256: '0'.repeat(64), expectedSize: bytes.length, fetchFn }),
    /checksum/,
  )
  await assert.rejects(
    downloadVerifiedArchive({ url: 'https://example.invalid/update', destination: path.join(root, 'large.zip'), expectedSha256: sha256, expectedSize: 2, fetchFn }),
    /exceeded/,
  )
})

test('replacement helper atomically swaps the app and keeps a recovery copy', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-updater-install-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const currentApp = path.join(root, 'HopIt.app')
  const stagedApp = path.join(root, 'staged', 'HopIt.app')
  const backupApp = path.join(root, '.HopIt.app.previous')
  await fs.mkdir(currentApp, { recursive: true })
  await fs.mkdir(stagedApp, { recursive: true })
  await fs.writeFile(path.join(currentApp, 'version.txt'), 'old')
  await fs.writeFile(path.join(stagedApp, 'version.txt'), 'new')
  await installStagedUpdate({ parentPid: 99999999, currentApp, stagedApp, backupApp, launch: false })
  assert.equal(await fs.readFile(path.join(currentApp, 'version.txt'), 'utf8'), 'new')
  assert.equal(await fs.readFile(path.join(backupApp, 'version.txt'), 'utf8'), 'old')
})

test('current app bundle path is derived without trusting a renderer path', () => {
  assert.equal(currentAppBundlePath('/Applications/HopIt.app/Contents/MacOS/HopIt'), '/Applications/HopIt.app')
  assert.equal(currentAppBundlePath('/usr/local/bin/hopit'), null)
})
