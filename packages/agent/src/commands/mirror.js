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
import { scopeForPath } from '@hopit/core/privacy-zone'

const DEFAULT_MIRROR_BRANCH = 'main'
export const MIRROR_AUTHOR_NAME = 'HopIt Mirror'
export const MIRROR_AUTHOR_EMAIL = 'mirror@hopit.local'

export async function runMirrorSync(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)

  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  const statePath = mirrorStatePath(options)
  const state = await readMirrorState(statePath)
  const existingEntry = state.codebases[codebaseId] ?? null

  const remoteUrl = options.remote ?? existingEntry?.remote ?? null
  if (!remoteUrl) {
    throw new Error('Missing --remote <git-url>. Pass --remote once to configure the mirror destination for this codebase.')
  }
  validateGitRemoteUrl(remoteUrl)

  const branch = options.branch ?? existingEntry?.branch ?? DEFAULT_MIRROR_BRANCH
  assertSafeGitOptionValue(branch, '--branch')

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

  try {
    runGit(['init', '--quiet'], workDir)
    runGit(['config', 'user.name', MIRROR_AUTHOR_NAME], workDir)
    runGit(['config', 'user.email', MIRROR_AUTHOR_EMAIL], workDir)
    runGit(['config', 'core.autocrlf', 'false'], workDir)
    runGit(['remote', 'add', 'origin', remoteUrl], workDir)
    // Unborn-branch rename; works whether or not any commit exists yet.
    runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], workDir)

    const remoteHead = fetchRemoteBranchHead(workDir, branch)
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
      runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], workDir)
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
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

// Reads whatever the remote branch currently points at, without ever writing
// back to it outside of the push at the end of a sync -- the mirror is a
// one-way projection, never a live bridge.
function fetchRemoteBranchHead(cwd, branch) {
  const fetchResult = spawnSync('git', ['fetch', 'origin', branch], { cwd, encoding: 'utf8' })
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
  if (label) return label
  const codebaseName = cloud.codebase?.name ?? cloud.codebase?.id ?? 'HopIt'
  return `Update ${codebaseName} to revision ${revision}`
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
