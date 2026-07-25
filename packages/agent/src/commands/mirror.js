// @ts-check
// Continuous, one-way, deterministic git mirror engine (decisions doc §8).
//
// `hop mirror-sync` builds one git commit per Main revision advance (interim,
// pre-Track-B stand-in for "one commit per merged proposal": see
// docs/git-replacement-decisions-2026-07.md §8 and
// docs/git-replacement-implementation-plan.md GR-E1/GR-E2) from the content
// hashes already recorded in file-version history, and pushes them to a
// user-configured remote. It never reads from the remote except to discover
// where the mirror branch currently points (one-way: HopIt -> git only).
//
// Determinism: the same Main history always produces byte-identical commits
// (fixed author/committer identity, commit dates taken from trail metadata
// -- the file-version `createdAt` recorded when the change actually
// happened -- never wall-clock). Two independent `mirror-sync` runs over the
// same source history therefore produce identical commit SHAs.
//
// Naming note: the plan doc's CLI sketch uses `hop mirror sync`, but `hop
// mirror` is already a live, documented alias for the unrelated
// `mirror-local` command (see docs/personal-production.md). Reusing that verb
// would silently change a production command, so this ships as the flat
// `hop mirror-sync` command instead, matching the existing `import-git`,
// `import-git-url`, `sync-once` naming convention. GR-E2 should keep this
// naming when it adds `mirror-set-remote` + automation.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createCloudGraphService, validateCloudGraphContract } from '../cloud/d1-graph-service.js'
import { fileScope } from '../constants.js'
import { emit, readJson, writeJson } from '../io.js'
import { normalizeCloudFileEntry } from '../journal.js'
import { agentStateRootFromOptions } from '../workspace-index.js'
import { assertSafeCloudPath } from '../workspace-manifest.js'
import { materializeCloudEntry } from './sync.js'
import { runGit } from './export.js'
import { assertSafeGitOptionValue, validateGitRemoteUrl } from './import.js'
import { reportResult } from '../output.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { clientEncryptionConfigFromOptions, decryptClientPayload, encryptClientPayload, hashBuffer } from '@hopit/core/crypto'

const DEFAULT_MIRROR_BRANCH = 'main'
export const MIRROR_AUTHOR_NAME = 'HopIt Mirror'
export const MIRROR_AUTHOR_EMAIL = 'mirror@hopit.local'
// Synthetic path used only to derive client-encryption AAD/zone metadata for
// the mirror deploy key -- there is no such file in the graph. Deliberately
// under `.private/env/` so it reuses the exact "secrets" privacy zone (and
// the "must never reach D1/R2 unencrypted" rule) that real `.private/env/`
// content already gets (decisions doc §7/§8).
export const MIRROR_DEPLOY_KEY_PATH = '.private/env/mirror-deploy-key'

export async function runMirrorSync(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)

  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  const statePath = mirrorStatePath(options)
  const state = await readMirrorState(statePath)
  const existingEntry = state.codebases[codebaseId] ?? null
  // GR-E2: a hosted runner has no prior local mirror-state.json entry on its
  // first run for a codebase, so the remote/branch configured via `hop
  // mirror-set-remote` (persisted server-side in codebase_settings) is the
  // fallback source of truth. Explicit `--remote`/`--branch` always win.
  const settings = await cloudService.readCodebaseSettings(codebaseId).catch(() => null)

  const remoteUrl = options.remote ?? existingEntry?.remote ?? settings?.mirrorRemoteUrl ?? null
  if (!remoteUrl) {
    throw new Error('Missing --remote <git-url>. Pass --remote once (or run `hop mirror-set-remote <url>`) to configure the mirror destination for this codebase.')
  }
  validateGitRemoteUrl(remoteUrl)

  const branch = options.branch ?? existingEntry?.branch ?? settings?.mirrorBranch ?? DEFAULT_MIRROR_BRANCH
  assertSafeGitOptionValue(branch, '--branch')

  const deployKeyPath = await materializeDeployKeyFile(settings, options)

  // Pre-Track-B there is no divergent proposal/branch model yet: every write
  // lands directly on what will become Main, so the graph's own revision
  // counter *is* the Main revision. `cloud.main.revision` only starts
  // diverging once Track B lands merge-to-Main as a distinct step; prefer the
  // graph revision so the mirror keeps advancing in this interim world.
  const targetRevision = integerOrNull(cloud.revision) ?? integerOrNull(cloud.main?.revision) ?? 0
  const lastMirroredRevision = integerOrNull(existingEntry?.lastMirroredRevision) ?? 0

  const versions = sortedFileVersions(await cloudService.listFileVersions())
  const revisions = distinctRevisionsInRange(versions, lastMirroredRevision, targetRevision)
  const trailLabels = await trailLabelsByRevision(cloudService, codebaseId)

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-mirror-'))
  let commitsCreated = 0
  let headCommit = existingEntry?.lastCommit ?? null
  let omittedPrivatePaths = 0
  // A deploy key is only meaningful for SSH remotes; HTTPS remotes carry
  // credentials in the URL itself (validated by `validateGitRemoteUrl`).
  const gitEnv = deployKeyPath
    ? { ...process.env, GIT_SSH_COMMAND: `ssh -i ${deployKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` }
    : process.env

  try {
    runGit(['init', '--quiet'], workDir)
    runGit(['config', 'user.name', MIRROR_AUTHOR_NAME], workDir)
    runGit(['config', 'user.email', MIRROR_AUTHOR_EMAIL], workDir)
    runGit(['config', 'core.autocrlf', 'false'], workDir)
    runGit(['remote', 'add', 'origin', remoteUrl], workDir)
    // Unborn-branch rename; works whether or not any commit exists yet.
    runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], workDir)

    const remoteHead = fetchRemoteBranchHead(workDir, branch, gitEnv)
    if (remoteHead) {
      runGit(['reset', '--hard', remoteHead], workDir)
      headCommit = remoteHead
    }

    for (const revision of revisions) {
      const snapshot = snapshotFilesAtRevision(versions, revision)
      const included = {}
      for (const [relativePath, file] of snapshot.entries()) {
        assertSafeCloudPath(relativePath)
        if (isOwnerPrivate(relativePath, file)) {
          omittedPrivatePaths += 1
          continue
        }
        included[relativePath] = file
      }

      await replaceWorkingTreeContents(workDir, included, cloudService)

      runGit(['add', '-A', '--', '.'], workDir)
      const message = commitMessageForRevision(cloud, revision, trailLabels)
      const isoDate = commitDateForRevision(versions, revision)
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: MIRROR_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: MIRROR_AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_NAME: MIRROR_AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: MIRROR_AUTHOR_EMAIL,
        GIT_COMMITTER_DATE: isoDate,
      }
      runGit(['commit', '--allow-empty', '-m', message], workDir, commitEnv)
      headCommit = runGit(['rev-parse', 'HEAD'], workDir).stdout.trim()
      commitsCreated += 1
    }

    if (commitsCreated > 0) {
      runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], workDir, gitEnv)
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
    if (deployKeyPath) await fs.rm(path.dirname(deployKeyPath), { recursive: true, force: true })
  }

  const finalRevision = revisions.length > 0 ? revisions[revisions.length - 1] : lastMirroredRevision
  state.codebases[codebaseId] = {
    remote: remoteUrl,
    branch,
    lastMirroredRevision: finalRevision,
    lastCommit: headCommit,
    updatedAt: new Date().toISOString(),
  }
  await writeMirrorState(statePath, state)

  const result = {
    ok: true,
    command: 'mirror-sync',
    codebaseId,
    remote: remoteUrl,
    branch,
    commitsCreated,
    lastMirroredRevision: finalRevision,
    headCommit,
    omittedPrivatePaths,
  }
  await emit(options, 'git.mirror_synced', result)
  console.log(JSON.stringify(result, null, 2))
  return result
}

// `hop mirror-set-remote <url>` (GR-E2, decisions §8) -- configures the
// mirror destination + optional deploy key server-side in
// `codebase_settings`, so a hosted runner (with no prior local mirror-state)
// still knows where to push. The deploy key, if given, is always encrypted
// client-side before it is ever sent to the cloud backend; the plaintext
// never leaves this process.
export async function runMirrorSetRemote(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'

  const remoteUrl = options.remote ?? null
  if (!remoteUrl) {
    throw new Error('Usage: hop mirror-set-remote <git-url> [--branch <name>] [--deploy-key <path-to-private-key>]')
  }
  validateGitRemoteUrl(remoteUrl)

  const branch = options.branch ?? DEFAULT_MIRROR_BRANCH
  assertSafeGitOptionValue(branch, '--branch')

  const update = { remoteUrl, branch }
  if (options['clear-deploy-key']) {
    update.deployKeyCiphertext = null
    update.deployKeyMetadata = null
  } else {
    const plaintext = await readDeployKeyPlaintext(options)
    if (plaintext !== null) {
      const config = clientEncryptionConfigFromOptions(options)
      if (!config) {
        throw new Error(
          'Storing a mirror deploy key requires a client encryption key (HOPIT_CLIENT_ENCRYPTION_KEY), same rule as .private/env/: the deploy key must never reach D1/R2 unencrypted.',
        )
      }
      const buffer = Buffer.from(plaintext, 'utf8')
      const encrypted = encryptClientPayload({
        buffer,
        codebaseId,
        relativePath: MIRROR_DEPLOY_KEY_PATH,
        plaintextHash: hashBuffer(buffer),
        config,
      })
      update.deployKeyCiphertext = encrypted.buffer.toString('base64')
      update.deployKeyMetadata = encrypted.metadata
    }
  }

  const updated = await cloudService.setMirrorRemote(codebaseId, update)
  const result = {
    ok: true,
    codebaseId,
    mirrorRemoteUrl: updated.mirrorRemoteUrl,
    mirrorBranch: updated.mirrorBranch,
    deployKeyConfigured: Boolean(updated.mirrorDeployKeyCiphertext),
  }
  await emit(options, 'git.mirror_remote_set', result)
  reportResult(options, result, ({ line, success }) => {
    line(`  ${success('✓')} Mirror remote set for ${codebaseId}: ${result.mirrorRemoteUrl} (${result.mirrorBranch})`)
  })
  return result
}

// GR-E3 (decisions §8/§9): "mark this as a release" ⇒ an annotated git tag
// on the mirror, at the mirror commit for the release's pinned Main
// revision, with the release name/notes as the tag message. Called from
// `hop release` right after the release row is created.
//
// Best-effort: returns `null` (never throws) when this codebase has no
// mirror configured at all -- releasing is meaningful without a mirror.
// Once a mirror *is* configured, failures (mirror hasn't caught up to this
// revision yet, push rejected, etc.) throw so the caller can surface a
// non-blocking notification, same "failure surfaces, never blocks the
// product action" rule as GR-E2's mirror-on-merge.
export async function runMirrorTagRelease(options, { cloudService, cloud, release }) {
  const codebaseId = cloud.codebase?.id ?? release.codebaseId
  const settings = await cloudService.readCodebaseSettings(codebaseId).catch(() => null)
  const statePath = mirrorStatePath(options)
  const state = await readMirrorState(statePath)
  const existingEntry = state.codebases[codebaseId] ?? null

  const remoteUrl = options.remote ?? existingEntry?.remote ?? settings?.mirrorRemoteUrl ?? null
  if (!remoteUrl) return null
  validateGitRemoteUrl(remoteUrl)

  const branch = options.branch ?? existingEntry?.branch ?? settings?.mirrorBranch ?? DEFAULT_MIRROR_BRANCH
  assertSafeGitOptionValue(branch, '--branch')

  if (!Number.isSafeInteger(release?.pinnedRevision)) {
    throw new Error('runMirrorTagRelease requires a release with an integer pinnedRevision.')
  }
  const tagName = assertSafeGitTagName(release.name)

  const deployKeyPath = await materializeDeployKeyFile(settings, options)
  const gitEnv = deployKeyPath
    ? { ...process.env, GIT_SSH_COMMAND: `ssh -i ${deployKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` }
    : process.env

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-mirror-tag-'))
  try {
    runGit(['init', '--quiet'], workDir)
    runGit(['config', 'user.name', MIRROR_AUTHOR_NAME], workDir)
    runGit(['config', 'user.email', MIRROR_AUTHOR_EMAIL], workDir)
    runGit(['remote', 'add', 'origin', remoteUrl], workDir)

    const remoteHead = fetchRemoteBranchHead(workDir, branch, gitEnv)
    if (!remoteHead) {
      throw new Error(`Mirror branch "${branch}" has no commits on the configured remote yet. Run \`hop mirror-sync\` before tagging a release.`)
    }

    const commitSha = findMirrorCommitForRevision(workDir, remoteHead, release.pinnedRevision)
    if (!commitSha) {
      throw new Error(`No mirror commit found for Main revision ${release.pinnedRevision} yet. Run \`hop mirror-sync\` to catch the mirror up before tagging release "${release.name}".`)
    }

    const tagMessage = release.notes ? `${release.name}\n\n${release.notes}` : release.name
    const tagEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: MIRROR_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: MIRROR_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: MIRROR_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: MIRROR_AUTHOR_EMAIL,
    }
    runGit(['tag', '-f', '-a', '-m', tagMessage, '--', tagName, commitSha], workDir, tagEnv)
    runGit(['push', 'origin', `refs/tags/${tagName}`], workDir, gitEnv)
    const treeSha = runGit(['rev-parse', `${commitSha}^{tree}`], workDir).stdout.trim()

    const result = {
      ok: true,
      command: 'mirror-tag',
      codebaseId,
      remote: remoteUrl,
      branch,
      tagName,
      commitSha,
      treeSha,
      releaseId: release.releaseId,
      pinnedRevision: release.pinnedRevision,
    }
    await emit(options, 'git.mirror_tagged', result)
    return result
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
    if (deployKeyPath) await fs.rm(path.dirname(deployKeyPath), { recursive: true, force: true })
  }
}

// Validates a release name as a git tag ref name by delegating to git's own
// `check-ref-format`, rather than re-implementing the ref-name grammar --
// same "trust the tool's own validator" approach as `validateGitRemoteUrl`
// leaning on the URL parser. Rejects anything git itself would reject as a
// `refs/tags/<name>` (spaces, `~^:?*[\`, `..`, a trailing `.lock`, etc.),
// which also rules out flag-injection via a name starting with `-` once
// combined with the `--` separator used before it is passed to `git tag`.
export function assertSafeGitTagName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Release name must be a non-empty string to use as a git tag name.')
  }
  const check = spawnSync('git', ['check-ref-format', '--allow-onelevel', `refs/tags/${name}`], { encoding: 'utf8' })
  if (check.status !== 0) {
    throw new Error(`Release name "${name}" is not usable as a git tag name (spaces, "~^:?*[\\", ".." and a trailing ".lock" are not allowed). Choose a different release name to tag the mirror.`)
  }
  return name
}

// Finds the mirror commit carrying a `Main-Revision: <revision>` git trailer
// (see `commitMessageForRevision`), reading the trailer via git's own
// trailer parser (`%(trailers:...)`) rather than string-matching commit
// messages by hand. This is what lets a release tag land on exactly the
// mirror commit for its pinned Main revision without any local
// revision-to-commit bookkeeping -- the pushed git history is the source of
// truth.
function findMirrorCommitForRevision(cwd, head, revision) {
  const result = spawnSync(
    'git',
    ['log', head, '--format=%H%x09%(trailers:key=Main-Revision,valueonly,separator=%x2C)'],
    { cwd, encoding: 'utf8' },
  )
  if (result.status !== 0) return null
  for (const line of result.stdout.split('\n')) {
    if (!line) continue
    const [sha, rawValue] = line.split('\t')
    if (!sha || rawValue === undefined) continue
    if (Number(rawValue.trim()) === revision) return sha
  }
  return null
}

async function readDeployKeyPlaintext(options) {
  if (options['deploy-key-value'] !== undefined) return String(options['deploy-key-value'])
  if (options['deploy-key']) return fs.readFile(options['deploy-key'], 'utf8')
  return null
}

// Decrypts the stored deploy-key ciphertext back into plaintext, if one is
// configured and this process holds the client encryption key. Returns null
// (never throws) when no deploy key is configured -- most remotes (HTTPS
// with an embedded token, or a local/CI-trusted SSH agent) don't need one.
export function decryptMirrorDeployKey(settings, options) {
  if (!settings?.mirrorDeployKeyCiphertext || !settings?.mirrorDeployKeyMetadata) return null
  const config = clientEncryptionConfigFromOptions(options)
  if (!config) {
    throw new Error('client_encryption_key_missing: a mirror deploy key is configured for this codebase but this process has no HOPIT_CLIENT_ENCRYPTION_KEY to decrypt it.')
  }
  const buffer = Buffer.from(settings.mirrorDeployKeyCiphertext, 'base64')
  return decryptClientPayload({
    buffer,
    codebaseId: settings.codebaseId,
    relativePath: MIRROR_DEPLOY_KEY_PATH,
    encryption: settings.mirrorDeployKeyMetadata,
    config,
  }).toString('utf8')
}

// Writes a decrypted deploy key to a 0600 temp file for the duration of one
// `mirror-sync` run (needed for `GIT_SSH_COMMAND -i <path>`), or returns null
// when no deploy key is configured. Caller is responsible for deleting it.
async function materializeDeployKeyFile(settings, options) {
  const plaintext = decryptMirrorDeployKey(settings, options)
  if (!plaintext) return null
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-mirror-key-'))
  const keyPath = path.join(dir, 'deploy_key')
  await fs.writeFile(keyPath, plaintext.endsWith('\n') ? plaintext : `${plaintext}\n`, { mode: 0o600 })
  return keyPath
}

// Reads whatever the remote branch currently points at, without ever writing
// back to it outside of the push at the end of a sync -- the mirror is a
// one-way projection, never a live bridge.
function fetchRemoteBranchHead(cwd, branch, env = process.env) {
  const fetchResult = spawnSync('git', ['fetch', 'origin', branch], { cwd, encoding: 'utf8', env })
  if (fetchResult.status !== 0) return null
  const revResult = spawnSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd, encoding: 'utf8' })
  if (revResult.status !== 0) return null
  const sha = revResult.stdout.trim()
  return sha.length > 0 ? sha : null
}

async function replaceWorkingTreeContents(workDir, files, cloudService) {
  const entries = await fs.readdir(workDir)
  for (const entry of entries) {
    if (entry === '.git') continue
    await fs.rm(path.join(workDir, entry), { recursive: true, force: true })
  }
  for (const [relativePath, file] of Object.entries(files)) {
    await materializeCloudEntry(workDir, relativePath, normalizeCloudFileEntry(relativePath, file), cloudService)
  }
}

function isOwnerPrivate(relativePath, file) {
  return scopeForPath(relativePath) === fileScope.ownerPrivate || file?.scope === fileScope.ownerPrivate
}

export function sortedFileVersions(versions) {
  return [...(versions ?? [])]
    .filter((row) => row && typeof row.path === 'string' && Number.isSafeInteger(row.graphRevision))
    .sort((a, b) => a.graphRevision - b.graphRevision || (a.versionId ?? 0) - (b.versionId ?? 0) || a.path.localeCompare(b.path))
}

export function snapshotFilesAtRevision(sortedVersions, revision) {
  const files = new Map()
  for (const row of sortedVersions) {
    if (row.graphRevision > revision) break
    if (row.newFile) files.set(row.path, row.newFile)
    else files.delete(row.path)
  }
  return files
}

export function distinctRevisionsInRange(sortedVersions, lastMirroredRevision, targetRevision) {
  const seen = new Set()
  for (const row of sortedVersions) {
    if (row.graphRevision > lastMirroredRevision && row.graphRevision <= targetRevision) seen.add(row.graphRevision)
  }
  return [...seen].sort((a, b) => a - b)
}

function commitDateForRevision(sortedVersions, revision) {
  const row = sortedVersions.find((entry) => entry.graphRevision === revision)
  return row?.createdAt ?? new Date(0).toISOString()
}

function commitMessageForRevision(cloud, revision, trailLabels) {
  const label = trailLabels.get(revision)
  const subject = label ?? `Update ${cloud.codebase?.name ?? cloud.codebase?.id ?? 'HopIt'} to revision ${revision}`
  // GR-E3: a `Main-Revision: <n>` git trailer on every mirror commit is the
  // durable, remote-verifiable way to answer "which mirror commit is Main
  // revision N at?" when tagging a release -- the local mirror-state.json
  // revision bookkeeping above is per-machine/per-runner and not a source of
  // truth the way the pushed git history itself is. See
  // `findMirrorCommitForRevision` below.
  return `${subject}\n\nMain-Revision: ${revision}`
}

async function trailLabelsByRevision(cloudService, codebaseId) {
  const map = new Map()
  if (typeof cloudService.listTrailEpisodes !== 'function') return map
  try {
    const episodes = await cloudService.listTrailEpisodes(codebaseId)
    for (const episode of episodes) {
      if (Number.isSafeInteger(episode.toRevision) && episode.label) map.set(episode.toRevision, episode.label)
    }
  } catch {
    // Best-effort: fall back to the generic revision message.
  }
  return map
}

function mirrorStatePath(options) {
  return options['mirror-state'] ?? path.join(agentStateRootFromOptions(options), 'mirror-state.json')
}

async function readMirrorState(statePath) {
  if (!existsSync(statePath)) return { schemaVersion: 1, codebases: {} }
  const parsed = await readJson(statePath)
  return {
    schemaVersion: 1,
    codebases: parsed && typeof parsed.codebases === 'object' && parsed.codebases !== null ? parsed.codebases : {},
  }
}

async function writeMirrorState(statePath, state) {
  await writeJson(statePath, state)
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null
}
