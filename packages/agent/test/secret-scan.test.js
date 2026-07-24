import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  isScannableTextEntry,
  scanTextForSecrets,
  secretFindingsForEntry,
  secretPatternKind,
  shannonEntropy,
} from '../src/secret-scan.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { syncOnce } from '../src/commands/sync.js'
import { readNdjson } from '../src/io.js'
import { entryEncoding, entryKind } from '../src/constants.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function randomAlnum(length, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function randomBase64(byteLength) {
  return randomBytes(byteLength).toString('base64')
}

// -------------------------------------------------------------------------
// Seeded corpus: >=20 fixture files with a planted secret each, spanning
// every pattern category the scanner recognizes. Accept: 100% flagged.
// -------------------------------------------------------------------------

function plantedFixtures() {
  const fixtures = []

  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `aws-${i}.env`,
      patternId: secretPatternKind.awsAccessKeyId,
      content: `# deploy credentials\nAWS_ACCESS_KEY_ID=AKIA${randomAlnum(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}\nAWS_REGION=us-east-1\n`,
    })
  }

  const githubPrefixes = ['ghp', 'gho', 'ghu', 'ghs']
  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `github-${i}.sh`,
      patternId: secretPatternKind.githubToken,
      content: `export GITHUB_TOKEN=${githubPrefixes[i % githubPrefixes.length]}_${randomAlnum(40)}\n`,
    })
  }

  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `stripe-${i}.js`,
      patternId: secretPatternKind.stripeLiveSecretKey,
      content: `module.exports = {\n  stripeKey: 'sk_live_${randomAlnum(24)}',\n}\n`,
    })
  }

  const slackPrefixes = ['xoxb', 'xoxa', 'xoxp', 'xoxr', 'xoxs']
  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `slack-${i}.yaml`,
      patternId: secretPatternKind.slackToken,
      content: `notifications:\n  slack_token: "${slackPrefixes[i % slackPrefixes.length]}-${randomAlnum(20)}-${randomAlnum(20)}"\n`,
    })
  }

  const pemHeaders = [
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----',
  ]
  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `key-${i}.pem`,
      patternId: secretPatternKind.privateKeyPem,
      content: `${pemHeaders[i]}\n${randomBase64(200)}\n-----END PRIVATE KEY-----\n`,
    })
  }

  const entropyIdentifiers = ['apiKey', 'clientSecret', 'sessionToken', 'privateKey']
  for (let i = 0; i < 4; i += 1) {
    fixtures.push({
      name: `entropy-${i}.js`,
      patternId: secretPatternKind.highEntropyAssignment,
      content: `const ${entropyIdentifiers[i]} = "${randomBase64(24)}"\n`,
    })
  }

  return fixtures
}

test('seeded corpus: every planted secret across all pattern types is flagged (100% recall)', () => {
  const fixtures = plantedFixtures()
  assert.ok(fixtures.length >= 20, `expected >=20 fixtures, got ${fixtures.length}`)

  for (const fixture of fixtures) {
    const findings = scanTextForSecrets(fixture.content)
    assert.ok(findings.length > 0, `${fixture.name} was not flagged`)
    assert.ok(
      findings.some((finding) => finding.patternId === fixture.patternId),
      `${fixture.name} did not surface a ${fixture.patternId} finding (got ${JSON.stringify(findings)})`,
    )
  }
})

// -------------------------------------------------------------------------
// Clean corpus: this repo's own real source. Accept: 0 false positives.
// -------------------------------------------------------------------------

async function collectJsFiles(dir) {
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      files.push(...(await collectJsFiles(full)))
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

test('clean corpus: this repo\'s own src/ sample has zero false positives', async () => {
  const roots = [
    path.join(repoRoot, 'packages/agent/src'),
    path.join(repoRoot, 'packages/backend-d1/src'),
    path.join(repoRoot, 'packages/core/src'),
  ]
  const files = (await Promise.all(roots.map(collectJsFiles))).flat()
  assert.ok(files.length >= 20, `expected a meaningful clean-corpus sample, got ${files.length} files`)

  const flagged = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const findings = scanTextForSecrets(text)
    if (findings.length > 0) flagged.push({ file: path.relative(repoRoot, file), findings })
  }

  assert.deepEqual(flagged, [], `unexpected findings in clean source: ${JSON.stringify(flagged, null, 2)}`)
})

// -------------------------------------------------------------------------
// Scannability rules
// -------------------------------------------------------------------------

test('isScannableTextEntry skips directories, symlinks, base64/binary content, and .private/ + .git/ paths', () => {
  const textEntry = { kind: entryKind.file, encoding: entryEncoding.utf8, content: 'hello' }
  assert.equal(isScannableTextEntry('src/app.js', textEntry), true)
  assert.equal(isScannableTextEntry('.private/env/repo-root/.env.local', textEntry), false)
  assert.equal(isScannableTextEntry('.git/config', textEntry), false)
  assert.equal(isScannableTextEntry('bin/tool', { kind: entryKind.file, encoding: entryEncoding.base64, content: 'AAA=' }), false)
  assert.equal(isScannableTextEntry('src', { kind: entryKind.directory }), false)
  assert.equal(isScannableTextEntry('link', { kind: entryKind.symlink, encoding: entryEncoding.utf8, content: 'target' }), false)
})

test('secretFindingsForEntry never scans a .private/ file even when it contains a planted secret', () => {
  const entry = {
    kind: entryKind.file,
    encoding: entryEncoding.utf8,
    content: 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJ123456\n',
  }
  assert.deepEqual(secretFindingsForEntry('.private/env/repo-root/.env.local', entry), [])
  assert.ok(secretFindingsForEntry('config/.env.example.leak', entry).length > 0)
})

test('shannonEntropy is low for repetitive text and high for random-looking text', () => {
  assert.ok(shannonEntropy('aaaaaaaaaaaaaaaaaaaa') < 1)
  assert.ok(shannonEntropy(randomBase64(24)) >= 3.5)
})

// -------------------------------------------------------------------------
// Metric: median scan overhead < 5ms per file at journal time
// -------------------------------------------------------------------------

test('benchmark: median scan time per file is under 5ms', async () => {
  const files = await collectJsFiles(path.join(repoRoot, 'packages/agent/src'))
  const durations = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const startedAt = performance.now()
    scanTextForSecrets(text)
    durations.push(performance.now() - startedAt)
  }
  durations.sort((a, b) => a - b)
  const median = durations[Math.floor(durations.length / 2)]
  assert.ok(median < 5, `median scan time ${median}ms exceeds 5ms budget (n=${durations.length})`)
})

// -------------------------------------------------------------------------
// Integration: wired into the outbound journal path in commands/sync.js
// -------------------------------------------------------------------------

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-secret-scan-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = {
    quiet: true,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return options
}

test('performSyncOnce emits secret.suspected for a planted secret and still commits the write (never blocks)', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(
    path.join(options.workspace, 'deploy.env'),
    `AWS_ACCESS_KEY_ID=AKIA${randomAlnum(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}\n`,
    'utf8',
  )

  const result = await syncOnce(options, { trigger: 'manual' })
  assert.equal(result.writes, 1)

  const events = await readNdjson(options.events)
  const suspected = events.filter((entry) => entry.event === 'secret.suspected')
  assert.equal(suspected.length, 1)
  assert.equal(suspected[0].detail.path, 'deploy.env')
  assert.ok(suspected[0].detail.findings.some((f) => f.patternId === secretPatternKind.awsAccessKeyId))

  const acknowledged = events.filter((entry) => entry.event === 'cloud.acknowledged')
  assert.equal(acknowledged.length, 1, 'the flagged file must still be journaled and acknowledged (warn-only)')
})

test('performSyncOnce never scans a .private/ file', async (t) => {
  const options = await makeWorkspace(t)
  await fs.mkdir(path.join(options.workspace, '.private', 'env', 'repo-root'), { recursive: true })
  await fs.writeFile(
    path.join(options.workspace, '.private', 'env', 'repo-root', '.env.local'),
    `AWS_ACCESS_KEY_ID=AKIA${randomAlnum(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}\n`,
    'utf8',
  )

  await syncOnce(options, { trigger: 'manual' })

  const events = await readNdjson(options.events)
  assert.equal(events.filter((entry) => entry.event === 'secret.suspected').length, 0)
})

test('setting off means no scan: turning secret scanning off for the codebase suppresses secret.suspected', async (t) => {
  const options = await makeWorkspace(t)
  const { createCloudGraphService } = await import('../src/cloud/d1-graph-service.js')
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  await cloudService.setSecretScanning(cloud.codebase.id, { enabled: false })

  await fs.writeFile(
    path.join(options.workspace, 'deploy.env'),
    `AWS_ACCESS_KEY_ID=AKIA${randomAlnum(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}\n`,
    'utf8',
  )
  const result = await syncOnce(options, { trigger: 'manual' })
  assert.equal(result.writes, 1, 'the write itself must still succeed with scanning off')

  const events = await readNdjson(options.events)
  assert.equal(events.filter((entry) => entry.event === 'secret.suspected').length, 0)
})

test('secret scanning defaults on: a fresh codebase with no explicit setting still scans', async (t) => {
  const options = await makeWorkspace(t)
  const { createCloudGraphService } = await import('../src/cloud/d1-graph-service.js')
  const cloudService = createCloudGraphService(options)
  const settings = await cloudService.readCodebaseSettings()
  assert.equal(settings.secretScanningEnabled, true)
})
