// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCloudGraphService, summarizeGraphContract, validateCloudGraphContract } from '../cloud/d1-graph-service.js'
import { fileScope } from '../constants.js'
import { emit } from '../io.js'
import { countCloudScopes, countPathScopes, hashContent, normalizeCloudFileEntry } from '../journal.js'
import { serviceStatus } from '../service.js'
import { readAgentState } from '../status-state.js'
import { agentStateRootFromOptions, workspaceIndexPath } from '../workspace-index.js'
import { assertSafeCloudPath, pathsOverlap } from '../workspace-manifest.js'
import { materializeCloudEntry } from './sync.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, watch } from 'node:fs'

export async function exportGitSnapshot(options, exportOptions) {
  if (!options.output) {
    throw new Error('Missing --output <path> for Git export/publish.')
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)

  if (exportOptions.requireMerged && cloud.selectedState?.mergeState !== 'merged') {
    throw new Error('Publish requires the selected active change set to be reviewed and merged first.')
  }
  if (cloud.selectedState?.conflictState === 'conflicted') {
    throw new Error('Cannot export or publish a conflicted change set.')
  }

  const output = path.resolve(options.output)
  await assertExportOutputSafe(output, options)

  const files = {}
  const omittedPaths = []
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    assertSafeCloudPath(relativePath)
    const isOwnerPrivate = scopeForPath(relativePath) === fileScope.ownerPrivate || file.scope === fileScope.ownerPrivate
    if (isOwnerPrivate && (exportOptions.requireMerged || !options['include-private'])) {
      omittedPaths.push(relativePath)
      continue
    }
    files[relativePath] = file
  }

  await prepareCleanOutputDirectory(output, options)
  for (const [relativePath, file] of Object.entries(files)) {
    await materializeCloudEntry(output, relativePath, normalizeCloudFileEntry(relativePath, file), cloudService)
  }

  runGit(['init'], output)
  runGit(['config', 'user.name', 'HopIt'], output)
  runGit(['config', 'user.email', 'agent@hopit.local'], output)
  runGit(['add', '.'], output)
  const message =
    options.message ??
    `${exportOptions.requireMerged ? 'Publish' : 'Export'} ${cloud.codebase?.name ?? cloud.codebase?.id ?? 'HopIt'} revision ${cloud.revision}`
  runGit(['commit', '--allow-empty', '-m', message], output)
  const commit = runGit(['rev-parse', 'HEAD'], output).stdout.trim()

  const result = {
    ok: true,
    command: exportOptions.requireMerged ? 'publish' : 'export',
    output,
    commit,
    files: Object.keys(files).length,
    omittedScopeCounts: countPathScopes(omittedPaths),
    omittedPrivatePaths: omittedPaths.length,
    codebaseId: cloud.codebase?.id ?? null,
    revision: cloud.revision,
    mainRevision: cloud.main?.revision ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
  }

  await emit(options, exportOptions.requireMerged ? 'git.published' : 'git.exported', result)
  console.log(JSON.stringify(result, null, 2))
}

export async function validateCloud(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)
  const result = {
    ok: true,
    service: cloudService.type,
    location: cloudService.location,
    contract: summarizeGraphContract(cloud),
    fileCount: Object.keys(cloud.files ?? {}).length,
    scopeCounts: countCloudScopes(cloud),
  }
  console.log(JSON.stringify(result, null, 2))
}

export async function runDoctor(options) {
  let state = null
  let service = null
  const checks = []

  try {
    state = await readAgentState(options)
    checks.push(checkResult('cloud', state.status.cloud.exists, state.status.cloud.exists ? 'Cloud graph is reachable.' : 'Cloud graph is missing.'))
    checks.push(checkResult('workspace', state.status.workspace.exists, state.status.workspace.exists ? 'Workspace path exists.' : 'Workspace path is not created.'))
    checks.push(checkResult(
      'hydration',
      ['materialized', 'partial'].includes(state.status.workspace.hydration.state),
      `Workspace hydration is ${state.status.workspace.hydration.state}.`,
    ))
    checks.push(checkResult(
      'journal',
      state.status.journal.pendingCount === 0 && state.status.journal.failedCount === 0,
      `Journal pending=${state.status.journal.pendingCount}, failed=${state.status.journal.failedCount}.`,
    ))
    checks.push(checkResult(
      'remote-cursor',
      (state.status.remotePull.cursor.behindByRevisions ?? 0) === 0,
      `Workspace is ${state.status.remotePull.cursor.behindByRevisions ?? 'unknown'} revisions behind cloud.`,
    ))
  } catch (error) {
    checks.push(checkResult('agent-state', false, error.message))
  }

  const sessionConfigured = Boolean(
    options['session-id'] ||
      options['session-token'] ||
      process.env.HOPIT_SESSION_ID ||
      process.env.HOPIT_AGENT_SESSION_TOKEN,
  )
  const requesterConfigured = Boolean(options['requester-id'] || process.env.HOPIT_REQUESTER_ID)
  if (sessionConfigured && !requesterConfigured) {
    checks.push(checkResult(
      'requester-identity',
      false,
      'A session id/token is configured but no requester id is set, so visibility-filtered reads run as guest and see zero files (refresh would treat every workspace file as deletable). Set HOPIT_REQUESTER_ID to the codebase owner id, or re-run connected setup.',
    ))
  } else {
    checks.push(checkResult(
      'requester-identity',
      true,
      requesterConfigured
        ? 'Requester identity is configured for visibility-filtered reads.'
        : 'No session identity configured; reads run with local owner visibility.',
    ))
  }

  try {
    service = await serviceStatus(options)
    checks.push(checkResult(
      'service',
      service.running && service.ok,
      service.running ? (service.ok ? 'Service is running and reachable.' : `Service is running but unhealthy: ${service.error}`) : 'Service is not running.',
    ))
  } catch (error) {
    checks.push(checkResult('service', false, error.message))
  }

  const failed = checks.filter((check) => !check.ok)
  const result = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    profile: options.profile,
    codebaseId: options['codebase-id'] ?? state?.status.codebaseId ?? null,
    checks,
    service: service
      ? {
          running: service.running,
          pid: service.pid,
          statusUrl: service.statusUrl,
          error: service.error,
        }
      : null,
    status: state?.status
      ? {
          readiness: state.status.readiness,
          hydration: state.status.workspace.hydration,
          pendingWrites: state.status.journal.pendingCount,
          failedWrites: state.status.journal.failedCount,
          remoteBehindByRevisions: state.status.remotePull.cursor.behindByRevisions,
          remotePull: state.status.remotePull.state,
          watch: state.status.watch.state,
        }
      : null,
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

export function checkResult(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail,
  }
}

export async function backupAgentState(options) {
  const output = path.resolve(options.output ?? path.join(agentStateRootFromOptions(options), 'backups', backupDirectoryName(options)))
  await assertBackupOutputSafe(output, options)
  await prepareCleanOutputDirectory(output, options)

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const state = await readAgentState(options)
  const files = []

  await writeBackupFile(output, files, 'cloud.json', cloud)
  await writeBackupFile(output, files, 'status.json', state.status)
  await copyBackupFileIfExists(output, files, 'events.ndjson', options.events)
  await copyBackupFileIfExists(output, files, 'journal.ndjson', options.journal)
  await copyBackupFileIfExists(output, files, 'workspaces.json', workspaceIndexPath(options))

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? null,
    cloud: {
      service: cloudService.type,
      location: cloudService.location,
      revision: cloud.revision,
      fileCount: Object.keys(cloud.files ?? {}).length,
      scopeCounts: countCloudScopes(cloud),
    },
    workspace: {
      path: path.resolve(options.workspace),
      hydration: state.status.workspace.hydration,
    },
    files,
  }
  await writeBackupFile(output, files, 'manifest.json', manifest)

  console.log(JSON.stringify({
    ok: true,
    output,
    codebaseId: manifest.codebaseId,
    revision: manifest.cloud.revision,
    files: files.length,
    manifest: path.join(output, 'manifest.json'),
  }, null, 2))
}

export async function assertExportOutputSafe(output, options) {
  const workspace = path.resolve(options.workspace)
  const unsafeRoots = new Set([path.parse(output).root, os.homedir(), process.cwd()])
  if (unsafeRoots.has(output)) {
    throw new Error(`Refusing to export into unsafe output path: ${output}`)
  }
  if (pathsOverlap(output, workspace)) {
    throw new Error(`Refusing to export into or around the managed workspace: ${output}`)
  }
}

export async function assertBackupOutputSafe(output, options) {
  const unsafeRoots = new Set([path.parse(output).root, os.homedir(), process.cwd(), path.resolve(options.workspace)])
  if (unsafeRoots.has(output)) {
    throw new Error(`Refusing to write backup into unsafe output path: ${output}`)
  }
}

export async function prepareCleanOutputDirectory(output, options) {
  if (!existsSync(output)) {
    await fs.mkdir(output, { recursive: true })
    return
  }

  const entries = await fs.readdir(output)
  if (entries.length > 0 && !options.force) {
    throw new Error(`Export output is not empty: ${output}. Use --force to replace it.`)
  }

  await fs.rm(output, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })
}

export function backupDirectoryName(options) {
  const codebaseId = options['codebase-id'] ?? 'hopit'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${codebaseId}-${stamp}`
}

export async function writeBackupFile(output, files, relativePath, value) {
  const destination = path.join(output, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const content = `${JSON.stringify(value, null, 2)}\n`
  await fs.writeFile(destination, content, 'utf8')
  files.push({
    path: relativePath,
    bytes: Buffer.byteLength(content),
    sha256: hashContent(content),
  })
}

export async function copyBackupFileIfExists(output, files, relativePath, sourcePath) {
  if (!existsSync(sourcePath)) return
  const destination = path.join(output, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const content = await fs.readFile(sourcePath)
  await fs.writeFile(destination, content)
  files.push({
    path: relativePath,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  })
}


export function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }

  return result
}

