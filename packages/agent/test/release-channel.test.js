import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleasePublicationAllowed,
  buildReleaseManifest,
  buildReleaseUploadPlan,
  hasCompleteReleaseTargetSet,
  releaseVersion,
} from '../../../scripts/release-hop.mjs'

const built = [
  {
    target: 'darwin-arm64',
    packageName: 'hop-darwin-arm64',
    archivePath: '/tmp/hop-darwin-arm64.tar.gz',
    checksumPath: '/tmp/hop-darwin-arm64.tar.gz.sha256',
    sha256: 'abc123',
    verified: { mode: 'host-executed' },
  },
  {
    target: 'linux-x64',
    packageName: 'hop-linux-x64',
    archivePath: '/tmp/hop-linux-x64.tar.gz',
    checksumPath: '/tmp/hop-linux-x64.tar.gz.sha256',
    sha256: 'def456',
    verified: { mode: 'cross-structural' },
  },
  {
    target: 'darwin-x64',
    packageName: 'hop-darwin-x64',
    archivePath: '/tmp/hop-darwin-x64.tar.gz',
    checksumPath: '/tmp/hop-darwin-x64.tar.gz.sha256',
    sha256: 'ghi789',
    verified: { mode: 'cross-structural' },
  },
  {
    target: 'linux-arm64',
    packageName: 'hop-linux-arm64',
    archivePath: '/tmp/hop-linux-arm64.tar.gz',
    checksumPath: '/tmp/hop-linux-arm64.tar.gz.sha256',
    sha256: 'jkl012',
    verified: { mode: 'cross-structural' },
  },
]

const dmg = {
  fileName: 'HopIt-macOS.dmg',
  dmgPath: '/tmp/HopIt-macOS.dmg',
  checksumPath: '/tmp/HopIt-macOS.dmg.sha256',
  sha256: 'dmg123',
  verified: true,
  update: {
    fileName: 'HopIt-macOS.zip',
    archivePath: '/tmp/HopIt-macOS.zip',
    checksumPath: '/tmp/HopIt-macOS.zip.sha256',
    sha256: 'zip123',
    size: 123456,
    verified: true,
  },
}

test('release manifest pins every target to immutable versioned objects', () => {
  const manifest = buildReleaseManifest({
    version: '0.0.1+abc1234',
    gitSha: 'abc1234',
    builtAt: '2026-07-10T00:00:00.000Z',
    built,
  })

  assert.equal(manifest.schemaVersion, 2)
  assert.equal(
    manifest.targets['darwin-arm64'].key,
    'releases/0.0.1+abc1234/hop-darwin-arm64.tar.gz',
  )
  assert.equal(
    manifest.targets['linux-x64'].checksumKey,
    'releases/0.0.1+abc1234/hop-linux-x64.tar.gz.sha256',
  )
  assert.equal(Object.values(manifest.targets).some((target) => target.key.startsWith('latest/')), false)
})

test('release upload plan publishes the mutable channel pointer last', () => {
  const plan = buildReleaseUploadPlan({
    version: '0.0.1+abc1234',
    built,
    manifestPath: '/tmp/manifest.json',
  })

  assert.equal(plan.at(-1).key, 'latest/manifest.json')
  assert.equal(plan.at(-1).phase, 'channel-pointer')
  assert.equal(plan.slice(0, -1).every((upload) => upload.key.startsWith('releases/0.0.1+abc1234/')), true)
  assert.equal(plan.some((upload) => /latest\/hop-/.test(upload.key)), false)
})

test('release manifest and upload plan include the universal macOS DMG', () => {
  const manifest = buildReleaseManifest({
    version: '0.0.1+abc1234',
    gitSha: 'abc1234',
    builtAt: '2026-07-10T00:00:00.000Z',
    built,
    mac: dmg,
  })
  assert.equal(manifest.downloads.macos.key, 'releases/0.0.1+abc1234/HopIt-macOS.dmg')
  assert.equal(manifest.downloads.macos.sha256, 'dmg123')
  assert.equal(manifest.downloads.macos.signed, false)
  assert.equal(manifest.downloads.macos.notarized, false)
  assert.equal(manifest.downloads.macos.update.key, 'releases/0.0.1+abc1234/HopIt-macOS.zip')
  assert.equal(manifest.downloads.macos.update.sha256, 'zip123')

  const plan = buildReleaseUploadPlan({
    version: '0.0.1+abc1234',
    built,
    mac: dmg,
    manifestPath: '/tmp/manifest.json',
  })
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.dmg')), true)
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.dmg.sha256')), true)
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.zip')), true)
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.zip.sha256')), true)
  assert.equal(plan.some((upload) => upload.key === 'latest/desktop-manifest.json'), true)
  assert.equal(plan.at(-1).key, 'latest/manifest.json')
})

test('desktop-only release advances only the in-app Mac channel', () => {
  const plan = buildReleaseUploadPlan({
    version: '0.0.1+abc1234',
    built: built.filter((entry) => entry.target.startsWith('darwin-')),
    mac: { update: dmg.update },
    manifestPath: '/tmp/manifest.json',
    publishChannel: false,
    publishDesktopChannel: true,
  })
  assert.equal(plan.at(-1).key, 'latest/desktop-manifest.json')
  assert.equal(plan.at(-1).phase, 'desktop-channel-pointer')
  assert.equal(plan.some((upload) => upload.key === 'latest/manifest.json'), false)
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.dmg')), false)
  assert.equal(plan.some((upload) => upload.key.endsWith('/HopIt-macOS.zip')), true)
})

test('targeted release plans never replace the multi-platform channel pointer', () => {
  const plan = buildReleaseUploadPlan({
    version: '0.0.1+abc1234.20260710000000000',
    built: built.slice(0, 1),
    manifestPath: '/tmp/manifest.json',
  })

  assert.equal(hasCompleteReleaseTargetSet(built.slice(0, 1).map((entry) => entry.target)), false)
  assert.equal(plan.some((upload) => upload.key === 'latest/manifest.json'), false)
  assert.equal(plan.every((upload) => upload.key.startsWith('releases/')), true)
})

test('release versions use a unique build timestamp instead of reusing one SHA key', () => {
  const first = releaseVersion('2026-07-10T00:00:00.001Z')
  const second = releaseVersion('2026-07-10T00:00:00.002Z')
  assert.notEqual(first, second)
  assert.match(first, /^0\.0\.1\+[a-f0-9]+\.20260710000000001$/)
})

test('public release publication requires explicit unsigned approval', () => {
  assert.doesNotThrow(() => assertReleasePublicationAllowed({ dryRun: true }))
  assert.throws(
    () => assertReleasePublicationAllowed({ allowUnsigned: true }),
    /requires HOPIT_ACKNOWLEDGE_UNSIGNED_PUBLIC_RELEASE/,
  )
  assert.doesNotThrow(() => assertReleasePublicationAllowed({
    allowUnsigned: true,
    unsignedAcknowledgement: 'I_ACCEPT_UNSIGNED_PUBLIC_DISTRIBUTION',
  }))
  assert.throws(
    () => assertReleasePublicationAllowed(),
    /not signed or notarized/,
  )
})
