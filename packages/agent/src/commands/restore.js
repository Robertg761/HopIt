// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { contentStorageMode, entryKind } from '../constants.js'
import { emit } from '../io.js'
import { countPathScopes, normalizeCloudFileEntry } from '../journal.js'
import { pathsOverlap } from '../workspace-manifest.js'
import { prepareCleanOutputDirectory } from './export.js'
import { materializeCloudEntry } from './sync.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

// `hop restore` is the read half of `hop backup`. It never talks to a cloud
// service (fixture or D1): every check and every materialized byte comes from
// files already sitting in the backup folder, so restore works offline and
// cannot itself leak or require network credentials.
//
// A backup can only ever be as complete as the graph it captured. When a file
// entry has `contentStorage: 'object-blob'` (client-encrypted secrets, or any
// file routed to R2/S3/filesystem object storage) `cloud.json` holds only the
// hash/blobKey pointer, not the plaintext body -- the body lives in whatever
// blob store was configured at backup time and this command has no way to
// fetch it back. Restore is honest about this split instead of silently
// producing an incomplete workspace: verify reports it as "hash-only", and
// --execute skips those paths and lists them (with their hash/blobKey) so an
// operator can fetch the bodies from the object store separately.
const requiredBackupFiles = ['manifest.json', 'cloud.json', 'status.json']

export async function restoreAgentState(options) {
  const from = requireFromOption(options)
  const report = await buildVerifyReport(from)

  if (!options.execute) {
    await emitIfConfigured(options, report.ok ? 'restore.verified' : 'restore.verify_failed', report)
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return report
  }

  if (!report.ok) {
    await emitIfConfigured(options, 'restore.execute_refused', {
      from,
      reason: 'backup_verification_failed',
      issues: report.issues,
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 1
    return report
  }

  const result = await executeRestore(options, from, report)
  await emitIfConfigured(options, 'restore.materialized', result)
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function executeRestore(options, from, verifyReport) {
  if (!options.workspace) {
    throw new Error('Missing --workspace <dir> for restore --execute.')
  }

  const workspace = path.resolve(options.workspace)
  assertRestoreWorkspaceSafe(workspace, from)
  // Non-empty target is refused unless --force, in which case it is replaced
  // wholesale -- the same non-empty/--force contract `backup` and `export-git`
  // already use for their own output directories.
  await prepareCleanOutputDirectory(workspace, options)

  const cloud = JSON.parse(await fs.readFile(path.join(from, 'cloud.json'), 'utf8'))

  const written = []
  const hashOnlySkipped = []
  const missingSkipped = []

  for (const relativePath of Object.keys(cloud.files ?? {}).sort()) {
    let entry
    try {
      entry = normalizeCloudFileEntry(relativePath, cloud.files[relativePath])
    } catch (error) {
      missingSkipped.push({ path: relativePath, reason: error.message })
      continue
    }

    const classification = classifyCloudFileEntry(relativePath, entry)
    if (classification.category === 'hash-only') {
      hashOnlySkipped.push(classification.descriptor)
      continue
    }
    if (classification.category === 'missing') {
      missingSkipped.push(classification.descriptor)
      continue
    }

    // No cloudService: only reachable when the entry is inline (checked above),
    // so materializeCloudEntry never needs to fetch a blob here.
    await materializeCloudEntry(workspace, relativePath, entry, null)
    written.push({ path: relativePath, scope: entry.scope, kind: entry.kind })
  }

  const result = {
    ok: true,
    command: 'restore',
    mode: 'execute',
    from,
    workspace,
    codebaseId: cloud.codebase?.id ?? null,
    revision: cloud.revision ?? null,
    filesWritten: written.length,
    scopeCounts: countPathScopes(written.map((file) => file.path)),
    privateFilesRestored: written.filter((file) => file.scope === 'owner-private').length,
    hashOnlySkipped: hashOnlySkipped.length,
    hashOnlySkippedFiles: hashOnlySkipped,
    missingSkipped: missingSkipped.length,
    missingSkippedFiles: missingSkipped,
    verifyIssues: verifyReport.issues,
  }

  result.report = await writeRestoreReport(workspace, result)
  return result
}

async function writeRestoreReport(workspace, result) {
  const reportPath = path.join(path.dirname(workspace), 'restore-report.json')
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return reportPath
}

function requireFromOption(options) {
  if (!options.from) {
    throw new Error('Missing --from <backup-dir> for restore.')
  }
  return path.resolve(options.from)
}

async function emitIfConfigured(options, event, detail) {
  if (!options.events) return
  await emit(options, event, detail)
}

function assertRestoreWorkspaceSafe(workspace, from) {
  const unsafeRoots = new Set([path.parse(workspace).root, os.homedir(), process.cwd()])
  if (unsafeRoots.has(workspace)) {
    throw new Error(`Refusing to restore into unsafe workspace path: ${workspace}`)
  }
  if (pathsOverlap(workspace, from)) {
    throw new Error(`Refusing to restore into or around the backup source: ${workspace}`)
  }
}

// --- verify (dry-run-by-default) -------------------------------------------

export async function buildVerifyReport(from) {
  const issues = []
  const base = { ok: false, command: 'restore', mode: 'verify', from }

  if (!existsSync(from) || !(await fs.lstat(from)).isDirectory()) {
    issues.push(`Backup directory does not exist: ${from}`)
    return { ...base, issues, manifest: null, categories: null }
  }

  const manifestPath = path.join(from, 'manifest.json')
  let manifest = null
  if (!existsSync(manifestPath)) {
    issues.push('manifest.json is missing.')
  } else {
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    } catch (error) {
      issues.push(`manifest.json is not valid JSON: ${error.message}`)
    }
  }

  if (manifest) {
    if (manifest.schemaVersion !== 1) {
      issues.push(`Unsupported manifest schemaVersion: ${JSON.stringify(manifest.schemaVersion)}.`)
    }
    if (!Array.isArray(manifest.files)) {
      issues.push('manifest.files must be an array.')
    }
  }

  const fileChecks = manifest && Array.isArray(manifest.files)
    ? await Promise.all(manifest.files.map((entry) => verifyBackupFileEntry(from, entry)))
    : []
  for (const check of fileChecks) {
    if (!check.ok) issues.push(check.issue)
  }

  const checkedPaths = new Set(fileChecks.map((check) => check.path))
  for (const required of requiredBackupFiles) {
    if (checkedPaths.has(required)) continue
    if (!existsSync(path.join(from, required))) {
      issues.push(`Required backup file missing: ${required}`)
    }
  }

  let cloud = null
  const cloudPath = path.join(from, 'cloud.json')
  if (existsSync(cloudPath)) {
    try {
      cloud = JSON.parse(await fs.readFile(cloudPath, 'utf8'))
    } catch (error) {
      issues.push(`cloud.json is not valid JSON: ${error.message}`)
    }
  }

  let categories = null
  if (cloud) {
    categories = categorizeCloudFiles(cloud)
    if (categories.missing.count > 0) {
      issues.push(`cloud.json has ${categories.missing.count} malformed file entr${categories.missing.count === 1 ? 'y' : 'ies'} that cannot be verified or restored.`)
    }
    if (manifest?.cloud) {
      const actualFileCount = Object.keys(cloud.files ?? {}).length
      if (Number.isInteger(manifest.cloud.fileCount) && manifest.cloud.fileCount !== actualFileCount) {
        issues.push(`manifest.cloud.fileCount (${manifest.cloud.fileCount}) does not match cloud.json file count (${actualFileCount}).`)
      }
      if (Number.isInteger(manifest.cloud.revision) && manifest.cloud.revision !== cloud.revision) {
        issues.push(`manifest.cloud.revision (${manifest.cloud.revision}) does not match cloud.json revision (${cloud.revision}).`)
      }
    }
  }

  const journal = await verifyNdjsonFile(path.join(from, 'journal.ndjson'))
  if (journal.parseErrors.length > 0) {
    issues.push(`journal.ndjson has ${journal.parseErrors.length} unparsable line(s).`)
  }
  const events = await verifyNdjsonFile(path.join(from, 'events.ndjson'))
  if (events.parseErrors.length > 0) {
    issues.push(`events.ndjson has ${events.parseErrors.length} unparsable line(s).`)
  }
  const rotatedEvents = await verifyNdjsonFile(path.join(from, 'events.1.ndjson'))
  if (rotatedEvents.parseErrors.length > 0) {
    issues.push(`events.1.ndjson has ${rotatedEvents.parseErrors.length} unparsable line(s).`)
  }

  return {
    ...base,
    ok: issues.length === 0,
    manifest: manifest
      ? {
          schemaVersion: manifest.schemaVersion,
          createdAt: manifest.createdAt,
          codebaseId: manifest.codebaseId,
          cloud: manifest.cloud ?? null,
          workspace: manifest.workspace ?? null,
          trailEpisodes: manifest.trailEpisodes ?? null,
        }
      : null,
    filesChecked: fileChecks.length,
    filesVerified: fileChecks.filter((check) => check.ok).length,
    journal: ndjsonSummary(path.join(from, 'journal.ndjson'), journal),
    events: ndjsonSummary(path.join(from, 'events.ndjson'), events),
    rotatedEvents: ndjsonSummary(path.join(from, 'events.1.ndjson'), rotatedEvents),
    categories,
    issues,
  }
}

function ndjsonSummary(absolutePath, parsed) {
  return {
    present: existsSync(absolutePath),
    lines: parsed.lines,
    parseErrors: parsed.parseErrors.length,
  }
}

async function verifyBackupFileEntry(from, fileEntry) {
  const relativePath = fileEntry?.path
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, path: null, issue: 'manifest.files has an entry missing a path.' }
  }

  const absolutePath = path.join(from, relativePath)
  if (!existsSync(absolutePath)) {
    return { ok: false, path: relativePath, issue: `Backed-up file listed in manifest is missing on disk: ${relativePath}` }
  }

  const content = await fs.readFile(absolutePath)
  if (Number.isInteger(fileEntry.bytes) && content.length !== fileEntry.bytes) {
    return {
      ok: false,
      path: relativePath,
      issue: `Byte-length mismatch for ${relativePath}: manifest says ${fileEntry.bytes}, disk has ${content.length}.`,
    }
  }
  if (typeof fileEntry.sha256 === 'string' && fileEntry.sha256) {
    const actualHash = createHash('sha256').update(content).digest('hex')
    if (actualHash !== fileEntry.sha256) {
      return {
        ok: false,
        path: relativePath,
        issue: `Hash mismatch for ${relativePath}: manifest says ${fileEntry.sha256}, disk has ${actualHash}.`,
      }
    }
  }

  return { ok: true, path: relativePath }
}

async function verifyNdjsonFile(absolutePath) {
  if (!existsSync(absolutePath)) return { lines: 0, parseErrors: [] }
  const content = await fs.readFile(absolutePath, 'utf8')
  const lines = content.split('\n').filter((line) => line.length > 0)
  const parseErrors = []
  lines.forEach((line, index) => {
    try {
      JSON.parse(line)
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message })
    }
  })
  return { lines: lines.length, parseErrors }
}

// --- cloud file categorization ----------------------------------------------

// Every file in a backed-up cloud graph falls into exactly one bucket:
//   - restorable-with-content: directories, symlinks, and inline files -- the
//     full body is right there in cloud.json and --execute can write it as-is.
//   - hash-only: object-backed (contentStorage: 'object-blob', e.g. secrets or
//     any file routed to R2/S3/filesystem storage). cloud.json holds only the
//     hash/blobKey pointer; the plaintext body lives in whatever blob store was
//     configured when the backup was taken. Restorable later by fetching that
//     blob, not from this backup alone.
//   - missing: an object-backed entry that is ALSO missing the hash/blobKey
//     needed to even locate its body later -- a genuinely lost/corrupt
//     reference, not merely deferred to R2.
export function categorizeCloudFiles(cloud) {
  const restorableWithContent = []
  const hashOnly = []
  const missing = []

  for (const [relativePath, rawFile] of Object.entries(cloud.files ?? {})) {
    let entry
    try {
      entry = normalizeCloudFileEntry(relativePath, rawFile)
    } catch (error) {
      missing.push({ path: relativePath, reason: error.message })
      continue
    }

    const classification = classifyCloudFileEntry(relativePath, entry)
    if (classification.category === 'hash-only') hashOnly.push(classification.descriptor)
    else if (classification.category === 'missing') missing.push(classification.descriptor)
    else restorableWithContent.push(classification.descriptor)
  }

  return {
    restorableWithContent: summarizeCategory(restorableWithContent),
    hashOnly: summarizeCategory(hashOnly),
    missing: summarizeCategory(missing),
  }
}

function classifyCloudFileEntry(relativePath, entry) {
  if (entry.kind !== entryKind.file || entry.contentStorage !== contentStorageMode.objectBlob) {
    return { category: 'content', descriptor: { path: relativePath, scope: entry.scope, kind: entry.kind } }
  }

  // normalizeCloudFileEntry always synthesizes a hash (from the, likely empty,
  // inline `content`) even when none was given, so an absent hash is not a
  // reliable "corrupt" signal. blobKey is: with no blobKey there is nowhere to
  // later fetch the body from, so treat that as an unrecoverable entry rather
  // than a normal hash-only (deferred-to-object-storage) one.
  const blobKey = entry.blobKey ?? null
  if (!blobKey) {
    return {
      category: 'missing',
      descriptor: { path: relativePath, scope: entry.scope, reason: 'object-backed entry has no blobKey to fetch a body from later.' },
    }
  }

  return {
    category: 'hash-only',
    descriptor: {
      path: relativePath,
      scope: entry.scope,
      hash: entry.hash ?? entry.blobHash ?? null,
      blobProvider: entry.blobProvider ?? null,
      blobKey,
      size: entry.size ?? entry.blobSize ?? null,
    },
  }
}

const sampleLimit = 20

function summarizeCategory(items) {
  const paths = items.map((item) => item.path).filter((relativePath) => typeof relativePath === 'string')
  return {
    count: items.length,
    scopeCounts: countPathScopes(paths),
    samples: items.slice(0, sampleLimit),
  }
}
