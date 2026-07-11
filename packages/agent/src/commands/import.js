// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCloudGraphService, summarizeGraphContract } from '../cloud/d1-graph-service.js'
import { defaultFileStorageBudgetBytes, defaultLaunchAgentLabelPrefix, defaultMirrorSecretRoutes, entryKind, fixturePath, mirrorNonSecretEnvSuffixes, mirrorSecretFileNames } from '../constants.js'
import { isLocalOnlySecretPath, privacyZoneForPath } from '@hopit/core/crypto'
import { emit, readJson, slugify, writeJson } from '../io.js'
import { reportResult } from '../output.js'
import { countCloudScopes, countPathScopes, hashBuffer, hashContent, hashDirectoryEntry, hashSymlinkTarget, toCloudPath } from '../journal.js'
import { assertWorkspacePathSafe } from '../paths.js'
import { agentStateRootFromOptions, assertWorkspaceNotIndexedForOtherCodebase } from '../workspace-index.js'
import { assertSafeCloudPath, readImportableProjectFiles, secretSyncStatus, shouldSkipLiteralMirrorPath, sortedDirEntries } from '../workspace-manifest.js'
import { assertBackupOutputSafe, backupDirectoryName } from './export.js'
import { hydrateWorkspace } from './hydrate.js'
import { syncOnce } from './sync.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export async function initCloud(options) {
  const cloudService = createCloudGraphService(options)
  if ((await cloudService.exists()) && !options.force) {
    await emit(options, 'cloud.exists', { cloud: options.cloud })
    return
  }

  const fixture = await readJson(fixturePath)
  const cloud = await cloudService.initialize(fixture)
  await emit(options, 'cloud.initialized', {
    cloud: options.cloud,
    service: cloudService.type,
    files: Object.keys(fixture.files).length,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })
}

export async function importLocalProject(options) {
  if (!options.source) {
    throw new Error('Missing --source <path> for import.')
  }

  const source = path.resolve(options.source)
  const stat = await fs.stat(source)
  if (!stat.isDirectory()) {
    throw new Error(`Import source is not a directory: ${source}`)
  }
  await assertWorkspacePathSafe(options, { source })

  const cloudService = createCloudGraphService(options)
  if ((await cloudService.exists()) && !options.force) {
    await emit(options, 'import.exists', {
      cloud: options.cloud,
      source,
      reason: 'Use --force to replace the current local HopIt graph.',
    })
    return
  }

  const now = new Date().toISOString()
  const codebaseName = options['codebase-name'] ?? path.basename(source)
  const codebaseId = options['codebase-id'] ?? slugify(codebaseName)
  const importResult = await readImportableProjectFiles(source)
  const files = importResult.files
  const graph = {
    schemaVersion: 2,
    codebase: {
      id: codebaseId,
      name: codebaseName,
      ownerId: options['owner-id'] ?? 'local-owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: now,
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: `cs_${codebaseId}_local`,
      ownerId: options['owner-id'] ?? 'local-owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: options.visibility ?? 'private',
      effectiveVisibility: options.visibility ?? 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: options['owner-id'] ?? 'local-owner',
    },
    collaborators: [],
    session: {
      id: options['session-id'] ?? 'session_local',
      deviceName: options['device-name'] ?? 'local-device',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: null,
      effective: options.visibility ?? 'private',
    },
    revision: 1,
    files,
  }

  const cloud = await cloudService.initialize(graph)
  // Defense in depth: never wipe a workspace directory the index says belongs to
  // a different codebase, even if a caller mis-resolved options.workspace.
  await assertWorkspaceNotIndexedForOtherCodebase(options, codebaseId)
  await fs.rm(options.workspace, { recursive: true, force: true })
  await fs.rm(options.journal, { force: true })
  await fs.rm(options.events, { force: true })
  await emit(options, 'local.imported', {
    source,
    cloud: options.cloud,
    workspace: options.workspace,
    files: Object.keys(files).length,
    skipped: importResult.skipped,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })
  await hydrateWorkspace(options)
}

export async function mirrorLocalProject(options, context = {}) {
  if (!options.source) {
    throw new Error('Missing --source <path> for mirror.')
  }

  const source = path.resolve(options.source)
  const workspace = path.resolve(options.workspace)
  const sourceStat = await fs.stat(source)
  if (!sourceStat.isDirectory()) {
    throw new Error(`Mirror source is not a directory: ${source}`)
  }
  await assertWorkspacePathSafe(options, { source })

  const storageBudgetBytes = Number(options['storage-budget-bytes'] ?? process.env.HOPIT_STORAGE_BUDGET_BYTES ?? defaultFileStorageBudgetBytes)
  if (!Number.isFinite(storageBudgetBytes) || storageBudgetBytes < 0) {
    throw new Error(`Invalid --storage-budget-bytes value: ${options['storage-budget-bytes']}`)
  }

  const codebaseId = options['codebase-id'] ?? path.basename(workspace)
  // Defense in depth: fail closed before stopping the service, backing up, or
  // wiping if this workspace directory is indexed for a different codebase.
  await assertWorkspaceNotIndexedForOtherCodebase(options, codebaseId)
  const launchAgentLabel = options['launch-agent-label'] ?? `${defaultLaunchAgentLabelPrefix}.${codebaseId}`
  const routes = await mirrorSecretRoutesFromOptions(source, options)
  const secretSync = secretSyncStatus(options)
  const startedAt = new Date().toISOString()
  const stoppedService = options['skip-service-control']
    ? { skipped: true, reason: 'skip-service-control' }
    : await stopMirrorService(launchAgentLabel)

  const backup = await backupWorkspaceForMirror(options, startedAt)
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.mkdir(workspace, { recursive: true })

  const copyResult = await copyLiteralMirrorSource(source, workspace, routes)
  const sourceManifest = await buildLiteralMirrorManifest(source, { routes })
  const destinationManifest = await buildLiteralMirrorManifest(workspace)
  const diff = diffLiteralManifests(sourceManifest, destinationManifest)
  const rootEnvExists = existsSync(path.join(workspace, '.env.local'))
  const routedSecretCount = countLocalOnlySecretManifestEntries(destinationManifest)
  const routedSecretExists = routedSecretCount > 0
  const budget = storageBudgetReport(destinationManifest, storageBudgetBytes)

  const result = {
    ok: diff.clean && !rootEnvExists,
    action: context.action ?? 'mirror-local',
    source,
    workspace,
    codebaseId,
    startedAt,
    completedAt: new Date().toISOString(),
    service: stoppedService,
    backup,
    copied: copyResult,
    routes: [...routes.entries()].map(([from, to]) => ({ from, to })),
    remoteGit: context.remoteGit ?? null,
    manifest: {
      source: literalManifestSummary(sourceManifest),
      destination: literalManifestSummary(destinationManifest),
      diff,
    },
    secrets: {
      rootEnvExists,
      routedEnvExists: routedSecretExists,
      routedSecretCount,
      encryptedSyncEnabled: secretSync.enabled,
      encryptedSyncReason: secretSync.reason,
      encryptionScope: secretSync.scope,
    },
    storageBudget: budget,
    sync: {
      attempted: false,
      skipped: true,
      reason: budget.withinBudget ? null : 'storage_budget_exceeded',
    },
  }

  if (!diff.clean) {
    await emit(options, 'mirror.failed', {
      reason: 'manifest_mismatch',
      diff,
      backup: backup.output,
    })
    finishMirror(options, result)
    process.exitCode = 1
    return
  }

  if (rootEnvExists) {
    await emit(options, 'mirror.failed', {
      reason: 'root_env_local_present',
      backup: backup.output,
    })
    finishMirror(options, result)
    process.exitCode = 1
    return
  }

  if (!budget.withinBudget) {
    await emit(options, 'mirror.sync_skipped', {
      reason: 'storage_budget_exceeded',
      storageBudget: budget,
      backup: backup.output,
      service: stoppedService,
    })
    finishMirror(options, result)
    return
  }

  if (options['production-safe'] && routedSecretExists && !secretSync.enabled) {
    result.sync.reason = secretSync.reason
    await emit(options, 'mirror.sync_skipped', {
      reason: secretSync.reason,
      detail: 'Production-safe mirror kept routed secrets local because client-side encrypted secret sync is not configured.',
      backup: backup.output,
      service: stoppedService,
    })
    finishMirror(options, result)
    return
  }

  const syncResult = await syncOnce(options, { trigger: 'literal-mirror' })
  result.sync = {
    attempted: true,
    skipped: false,
    reason: null,
    result: syncResult,
  }

  if (!options['skip-service-control']) {
    result.service.restart = await startMirrorService(launchAgentLabel)
  }

  await emit(options, 'mirror.complete', {
    storageBudget: budget,
    backup: backup.output,
    sync: result.sync,
  })
  finishMirror(options, result)
}

// Print the mirror result: raw JSON under --json (unchanged), or a concise human
// summary. Suppressed entirely for internal callers (add, import-git) so only the
// top-level command summarizes.
function finishMirror(options, result) {
  reportResult(options, result, (w) => {
    if (result.ok) {
      w.line()
      w.line(`  ${w.success('✓')} ${w.bold('Mirror complete')} ${w.muted(result.codebaseId ?? '')}`)
      w.line(`     ${w.muted('Workspace')} ${result.workspace}`)
      const synced = result.sync?.attempted && !result.sync?.skipped
      w.line(`     ${w.muted('Cloud')}     ${synced ? 'synced' : (result.sync?.reason ?? 'not synced')}`)
    } else {
      w.line()
      w.line(`  ${w.danger('✗')} ${w.bold('Mirror did not complete cleanly')}`)
      const reason = result.manifest?.diff && !result.manifest.diff.clean
        ? 'workspace manifest mismatch'
        : (result.secrets?.rootEnvExists ? 'unrouted .env.local present' : 'see details')
      w.line(`     ${w.muted('Reason')}    ${reason}`)
      w.line(`     ${w.muted('Backup')}    ${result.backup?.output ?? 'n/a'}`)
    }
  })
}

export async function importGitProject(options) {
  if (options.url || options['git-url']) {
    await importRemoteGitProject(options)
    return
  }

  if (!options.source) {
    throw new Error('Missing --source <path> for import-git.')
  }

  const source = path.resolve(options.source)
  const gitPath = path.join(source, '.git')
  if (!existsSync(gitPath)) {
    throw new Error(`import-git requires a Git checkout with a .git entry: ${source}`)
  }

  const nextOptions = {
    ...options,
    'production-safe': true,
  }
  await mirrorLocalProject(nextOptions, { action: 'import-git', requireGit: true })
}

export async function importRemoteGitProject(options) {
  const remoteUrl = options.url ?? options['git-url']
  if (!remoteUrl) {
    throw new Error('Missing --url <git-url> for import-git-url.')
  }

  validateGitRemoteUrl(remoteUrl)

  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-git-import-'))
  const clonePath = path.join(cloneRoot, 'repo')
  const cloneStartedAt = new Date().toISOString()

  try {
    const cloneResult = await cloneGitRepository(remoteUrl, clonePath, options)
    await emit(options, 'git.clone_complete', {
      url: redactGitRemoteUrl(remoteUrl),
      source: clonePath,
      elapsedMs: cloneResult.elapsedMs,
    })

    const nextOptions = {
      ...options,
      source: clonePath,
      'production-safe': true,
    }
    await mirrorLocalProject(nextOptions, {
      action: 'import-git-url',
      requireGit: true,
      remoteGit: {
        url: redactGitRemoteUrl(remoteUrl),
        branch: options.branch ?? null,
        clonedAt: cloneStartedAt,
      },
    })
  } finally {
    await fs.rm(cloneRoot, { recursive: true, force: true })
  }
}

export async function cloneGitRepository(remoteUrl, outputPath, options) {
  const args = ['clone']
  if (options.branch) {
    assertSafeGitOptionValue(options.branch, '--branch')
    args.push('--branch', options.branch)
  }
  if (options.depth) {
    const depth = Number(options.depth)
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error(`Invalid --depth value: ${options.depth}`)
    }
    args.push('--depth', String(depth))
  }
  args.push('--', remoteUrl, outputPath)

  const timeoutMs = Number(options['git-timeout-ms'] ?? 10 * 60 * 1000)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`Invalid --git-timeout-ms value: ${options['git-timeout-ms']}`)
  }

  const startedAt = Date.now()
  const result = await runProcess('git', args, { timeoutMs })
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || 'git clone failed.'
    throw new Error(`Unable to clone Git repository: ${detail}`)
  }
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
  }
}

export function validateGitRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() !== remoteUrl || remoteUrl.length === 0) {
    throw new Error('Git URL must be a non-empty string without leading or trailing whitespace.')
  }
  if (remoteUrl.includes('\0') || remoteUrl.includes('\n') || remoteUrl.includes('\r')) {
    throw new Error('Git URL contains unsupported control characters.')
  }
  if (remoteUrl.startsWith('-')) {
    throw new Error('Git URL cannot start with a dash.')
  }
}

export function assertSafeGitOptionValue(value, optionName) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
    throw new Error(`${optionName} must be a non-empty value and cannot start with a dash.`)
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${optionName} contains unsupported control characters.`)
  }
}

export function redactGitRemoteUrl(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : ''
      parsed.password = parsed.password ? '***' : ''
    }
    return parsed.toString()
  } catch {
    return remoteUrl.replace(/^(ssh:\/\/)?([^@\s]+)@/, '$1***@')
  }
}

export function runProcess(command, args, { timeoutMs = 60_000, cwd = process.cwd(), input = null, outputLimit = 16_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out.`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = capText(stdout + chunk, outputLimit)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capText(stderr + chunk, outputLimit)
    })
    if (input !== null) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      child.stdin.end(input)
    }
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

export function capText(output, limit = 16_000) {
  return output.length > limit ? output.slice(-limit) : output
}


export async function mirrorSecretRoutesFromOptions(source, _options) {
  const routes = new Map()
  const sourcePaths = await listLiteralMirrorSourcePaths(source)
  const ignoredPaths = await listGitIgnoredMirrorPaths(source, sourcePaths)

  for (const [from, to] of defaultMirrorSecretRoutes) {
    if (sourcePaths.has(from)) {
      addMirrorSecretRoute(routes, sourcePaths, from, to)
    }
  }

  for (const relativePath of sourcePaths) {
    if (routes.has(relativePath) || relativePath.startsWith('.git/')) continue
    if (isMirrorSecretPath(relativePath)) {
      addMirrorSecretRoute(routes, sourcePaths, relativePath, `.private/env/repo-root/${relativePath}`)
    }
  }

  for (const relativePath of ignoredPaths) {
    if (routes.has(relativePath) || relativePath.startsWith('.git/')) continue
    addMirrorSecretRoute(routes, sourcePaths, relativePath, `.private/env/gitignored/${relativePath}`)
  }

  return routes
}

export async function listLiteralMirrorSourcePaths(source) {
  const paths = new Set()

  async function walk(dir, relativeDir = '') {
    const entries = await sortedDirEntries(dir)
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (shouldSkipLiteralMirrorPath(relativePath, entry)) continue
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (entry.isFile() || entry.isSymbolicLink()) paths.add(relativePath)
    }
  }

  await walk(source)
  return paths
}

export async function listGitIgnoredMirrorPaths(source, sourcePaths) {
  if (!existsSync(path.join(source, '.git')) || sourcePaths.size === 0) return new Set()
  if (!(await isGitWorkTree(source))) return new Set()

  const input = `${[...sourcePaths].join('\0')}\0`
  const result = await runProcess('git', ['check-ignore', '-z', '--stdin', '--no-index'], {
    cwd: source,
    input,
    outputLimit: 1_000_000,
  })
  if (result.exitCode === 1) return new Set()
  if (result.exitCode !== 0) return new Set()

  return new Set(result.stdout.split('\0').filter(Boolean).map(toCloudPath))
}

export async function isGitWorkTree(source) {
  const result = await runProcess('git', ['-C', source, 'rev-parse', '--is-inside-work-tree'])
  return result.exitCode === 0 && result.stdout === 'true'
}

export function addMirrorSecretRoute(routes, sourcePaths, from, desiredTo) {
  if (from.startsWith('.private/env/')) return

  let to = assertSafeCloudPath(desiredTo)
  if (to === from) return

  const routeTargets = new Set(routes.values())
  if (sourcePaths.has(to) || routeTargets.has(to)) {
    const ext = path.posix.extname(to)
    const stem = ext ? to.slice(0, -ext.length) : to
    const hash = hashContent(from).slice(0, 8)
    to = `${stem}.${hash}${ext}`
  }

  routes.set(from, to)
}

export function isMirrorSecretPath(relativePath) {
  const basename = relativePath.split('/').at(-1) ?? relativePath
  if (mirrorSecretFileNames.has(basename)) return true
  if (basename.startsWith('.env.')) {
    const suffixes = basename.slice('.env.'.length).split('.')
    return !suffixes.some((suffix) => mirrorNonSecretEnvSuffixes.has(suffix))
  }
  if (basename.endsWith('.pem') || basename.endsWith('.key')) return true
  return false
}

export async function backupWorkspaceForMirror(options, startedAt) {
  const workspace = path.resolve(options.workspace)
  const output = path.resolve(path.join(
    agentStateRootFromOptions(options),
    'backups',
    `workspace-mirror-${backupDirectoryName(options)}`,
  ))
  await assertBackupOutputSafe(output, options)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.rm(output, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })

  const workspaceBackup = path.join(output, 'workspace')
  if (existsSync(workspace)) {
    await copyLiteralMirrorSource(workspace, workspaceBackup, new Map())
  } else {
    await fs.mkdir(workspaceBackup, { recursive: true })
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: startedAt,
    workspace,
    backup: workspaceBackup,
  }
  await writeJson(path.join(output, 'manifest.json'), manifest)
  return {
    output,
    workspace: workspaceBackup,
    manifest: path.join(output, 'manifest.json'),
  }
}

export async function copyLiteralMirrorSource(source, destination, routes = new Map()) {
  const result = {
    files: 0,
    symlinks: 0,
    directories: 0,
    routedSecrets: 0,
    bytes: 0,
  }

  async function copyEntry(sourcePath, relativePath) {
    const routedPath = routes.get(relativePath)
    const targetRelativePath = routedPath ?? relativePath
    const destinationPath = path.join(destination, ...targetRelativePath.split('/'))
    const stat = await fs.lstat(sourcePath)

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath)
      await fs.mkdir(path.dirname(destinationPath), { recursive: true })
      await fs.rm(destinationPath, { recursive: true, force: true })
      await fs.symlink(target, destinationPath)
      result.symlinks += 1
      if (routedPath) result.routedSecrets += 1
      return
    }

    if (stat.isDirectory()) {
      if (routedPath) {
        throw new Error(`Secret route source must be a file or symlink, got directory: ${relativePath}`)
      }
      await fs.mkdir(destinationPath, { recursive: true })
      result.directories += 1
      const entries = await fs.readdir(sourcePath, { withFileTypes: true })
      let consideredChildren = 0
      for (const entry of entries) {
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
        if (shouldSkipLiteralMirrorPath(childRelativePath, entry)) continue
        consideredChildren += 1
        await copyEntry(path.join(sourcePath, entry.name), childRelativePath)
      }
      if (consideredChildren > 0 && await isDirectoryEmpty(destinationPath)) {
        await fs.rmdir(destinationPath)
        result.directories -= 1
        return
      }
      await fs.chmod(destinationPath, stat.mode)
      await fs.utimes(destinationPath, stat.atime, stat.mtime)
      return
    }

    if (!stat.isFile()) return

    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    const buffer = await readLiteralMirrorFileBuffer(sourcePath, relativePath)
    await fs.writeFile(destinationPath, buffer)
    await fs.chmod(destinationPath, stat.mode)
    await fs.utimes(destinationPath, stat.atime, stat.mtime)
    result.files += 1
    result.bytes += stat.size
    if (routedPath) result.routedSecrets += 1
  }

  await fs.mkdir(destination, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldSkipLiteralMirrorPath(entry.name, entry)) continue
    await copyEntry(path.join(source, entry.name), entry.name)
  }

  return result
}

export async function buildLiteralMirrorManifest(root, options = {}) {
  const routes = options.routes ?? new Map()
  const entries = {}
  const largestEntries = []

  function addEntry(relativePath, entry) {
    const normalizedPath = assertSafeCloudPath(relativePath)
    if (entries[normalizedPath]) {
      throw new Error(`Mirror manifest has duplicate routed path: ${normalizedPath}`)
    }
    entries[normalizedPath] = entry
    largestEntries.push({ path: normalizedPath, kind: entry.kind, size: entry.size })
    largestEntries.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    largestEntries.splice(20)
  }

  async function walk(dir, relativeDir = '') {
    const children = await fs.readdir(dir, { withFileTypes: true })
    let includedChildren = 0

    for (const child of children) {
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name
      if (shouldSkipLiteralMirrorPath(relativePath, child)) continue
      const routedPath = routes.get(relativePath)
      const manifestPath = routedPath ?? relativePath
      const absolutePath = path.join(dir, child.name)
      const stat = await fs.lstat(absolutePath)

      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absolutePath)
        addEntry(manifestPath, {
          kind: entryKind.symlink,
          hash: hashSymlinkTarget(target),
          size: Buffer.byteLength(target),
          encodedBytes: Buffer.byteLength(target),
          scope: scopeForPath(manifestPath),
          privacyZone: privacyZoneForPath(manifestPath),
          target,
        })
        includedChildren += 1
        continue
      }

      if (stat.isDirectory()) {
        if (routedPath) {
          throw new Error(`Secret route source must be a file or symlink, got directory: ${relativePath}`)
        }
        const childCount = await walk(absolutePath, relativePath)
        if (childCount === 0) {
          addEntry(relativePath, {
            kind: entryKind.directory,
            hash: hashDirectoryEntry(relativePath),
            size: 0,
            encodedBytes: 0,
            scope: scopeForPath(relativePath),
            privacyZone: privacyZoneForPath(relativePath),
            target: null,
          })
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }

      if (!stat.isFile()) continue

      const buffer = await readLiteralMirrorFileBuffer(absolutePath, relativePath)
      addEntry(manifestPath, {
        kind: entryKind.file,
        hash: hashBuffer(buffer),
        size: buffer.byteLength,
        encodedBytes: base64EncodedLength(buffer.byteLength),
        scope: scopeForPath(manifestPath),
        privacyZone: privacyZoneForPath(manifestPath),
        target: null,
      })
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)
  const scopeCounts = countPathScopes(Object.keys(entries))
  return {
    schemaVersion: 1,
    root: path.resolve(root),
    entryCount: Object.keys(entries).length,
    scopeCounts,
    entries,
    largestEntries,
  }
}

export async function isDirectoryEmpty(dir) {
  return (await fs.readdir(dir)).length === 0
}

export async function readLiteralMirrorFileBuffer(absolutePath, relativePath) {
  const buffer = await fs.readFile(absolutePath)
  if (relativePath !== '.git/config') return buffer

  return Buffer.from(sanitizeGitConfigContent(buffer.toString('utf8')), 'utf8')
}

export function sanitizeGitConfigContent(content) {
  return content.replace(
    /^(\s*(?:url|pushurl)\s*=\s*)(\S+)(.*)$/gim,
    (_match, prefix, url, suffix) => `${prefix}${stripGitRemoteCredentials(url)}${suffix}`,
  )
}

export function stripGitRemoteCredentials(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = ''
      parsed.password = ''
      return parsed.toString()
    }
    if (parsed.password) {
      parsed.password = ''
      return parsed.toString()
    }
    return remoteUrl
  } catch {
    return remoteUrl
  }
}

export function diffLiteralManifests(expected, actual) {
  const addedPaths = []
  const modifiedPaths = []
  const deletedPaths = []

  for (const relativePath of Object.keys(actual.entries).sort()) {
    const expectedEntry = expected.entries[relativePath]
    const actualEntry = actual.entries[relativePath]
    if (!expectedEntry) {
      addedPaths.push(relativePath)
      continue
    }
    if (
      expectedEntry.kind !== actualEntry.kind ||
      expectedEntry.hash !== actualEntry.hash ||
      expectedEntry.size !== actualEntry.size ||
      expectedEntry.scope !== actualEntry.scope ||
      (expectedEntry.target ?? null) !== (actualEntry.target ?? null)
    ) {
      modifiedPaths.push(relativePath)
    }
  }

  for (const relativePath of Object.keys(expected.entries).sort()) {
    if (!actual.entries[relativePath]) deletedPaths.push(relativePath)
  }

  return {
    clean: addedPaths.length === 0 && modifiedPaths.length === 0 && deletedPaths.length === 0,
    addedCount: addedPaths.length,
    modifiedCount: modifiedPaths.length,
    deletedCount: deletedPaths.length,
    samplePaths: [...addedPaths, ...modifiedPaths, ...deletedPaths].slice(0, 20),
  }
}

export function literalManifestSummary(manifest) {
  return {
    root: manifest.root,
    entryCount: manifest.entryCount,
    scopeCounts: manifest.scopeCounts,
    largestEntries: manifest.largestEntries.slice(0, 10),
  }
}

export function countLocalOnlySecretManifestEntries(manifest) {
  return Object.keys(manifest.entries ?? {}).filter((relativePath) => isLocalOnlySecretPath(relativePath)).length
}

export function storageBudgetReport(manifest, budgetBytes) {
  const uniquePayloads = new Map()
  let totalRawBytes = 0
  let totalEncodedBytes = 0

  for (const entry of Object.values(manifest.entries)) {
    if (entry.kind === entryKind.directory) continue
    totalRawBytes += entry.size
    totalEncodedBytes += entry.encodedBytes
    if (!uniquePayloads.has(entry.hash)) {
      uniquePayloads.set(entry.hash, {
        rawBytes: entry.size,
        encodedBytes: entry.encodedBytes,
      })
    }
  }

  let uniqueRawBytes = 0
  let uniqueEncodedBytes = 0
  for (const payload of uniquePayloads.values()) {
    uniqueRawBytes += payload.rawBytes
    uniqueEncodedBytes += payload.encodedBytes
  }

  return {
    budgetBytes,
    withinBudget: uniqueEncodedBytes <= budgetBytes,
    totalRawBytes,
    totalEncodedBytes,
    uniqueRawBytes,
    uniqueEncodedBytes,
    uniquePayloads: uniquePayloads.size,
    overByBytes: Math.max(0, uniqueEncodedBytes - budgetBytes),
  }
}

export function base64EncodedLength(byteLength) {
  return Math.ceil(byteLength / 3) * 4
}

export async function stopMirrorService(label) {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'launch-agent-only-on-darwin' }
  }

  const target = launchAgentTarget(label)
  const result = spawnSync('launchctl', ['bootout', target], { encoding: 'utf8' })
  if (result.status === 0) {
    return { skipped: false, stopped: true, label, target }
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (/No such process|Could not find specified service|service already unloaded/i.test(output)) {
    return { skipped: false, stopped: false, alreadyStopped: true, label, target }
  }

  return {
    skipped: false,
    stopped: false,
    label,
    target,
    status: result.status,
    error: output.trim() || 'launchctl bootout failed',
  }
}

export async function startMirrorService(label) {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'launch-agent-only-on-darwin' }
  }

  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  if (!existsSync(plistPath)) {
    return { skipped: true, reason: 'launch-agent-plist-missing', label, plistPath }
  }

  const domain = launchAgentDomain()
  const bootstrap = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
  const bootstrapOutput = `${bootstrap.stdout ?? ''}${bootstrap.stderr ?? ''}`
  if (bootstrap.status !== 0 && !/service already loaded|already exists/i.test(bootstrapOutput)) {
    return {
      skipped: false,
      started: false,
      label,
      plistPath,
      status: bootstrap.status,
      error: bootstrapOutput.trim() || 'launchctl bootstrap failed',
    }
  }

  const kickstart = spawnSync('launchctl', ['kickstart', '-k', launchAgentTarget(label)], { encoding: 'utf8' })
  return {
    skipped: false,
    started: kickstart.status === 0,
    label,
    plistPath,
    bootstrapStatus: bootstrap.status,
    kickstartStatus: kickstart.status,
    error: kickstart.status === 0 ? null : `${kickstart.stdout ?? ''}${kickstart.stderr ?? ''}`.trim(),
  }
}

export function launchAgentTarget(label) {
  return `${launchAgentDomain()}/${label}`
}

export function launchAgentDomain() {
  return `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
}
