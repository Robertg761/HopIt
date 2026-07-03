#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createD1Backend, isD1Configured } from '../../../src/lib/d1-backend.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const agentCli = path.join(repoRoot, 'packages/agent/src/cli.js')
const runnerId = process.env.HOPIT_ACTION_RUNNER_ID ?? `${os.hostname()}-${process.pid}`
const cloudBackend = configuredCloudBackend()
const workspaceRoot = process.env.HOPIT_ACTION_WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'hopit-actions-workspaces')
const stateRoot = process.env.HOPIT_ACTION_STATE_ROOT ?? path.join(os.tmpdir(), 'hopit-actions-state')
const pollIntervalMs = Number(process.env.HOPIT_ACTION_POLL_INTERVAL_MS ?? 5000)

const mode = process.argv[2] ?? 'run-once'

if (cloudBackend === 'unavailable') {
  throw new Error('Set HOPIT_CLOUD_BACKEND=d1 with HOPIT_D1_* values for the actions runner.')
}

const d1Backend = cloudBackend === 'd1' ? createD1Backend() : null

if (mode === 'loop') {
  await runLoop()
} else if (mode === 'run-once') {
  const ran = await runOnce()
  if (!ran) console.log('No queued HopIt action jobs.')
} else {
  throw new Error(`Unknown actions runner mode: ${mode}`)
}

async function runLoop() {
  console.log(`HopIt actions runner ${runnerId} polling ${cloudBackend}`)
  while (true) {
    await runOnce()
    await sleep(pollIntervalMs)
  }
}

async function runOnce() {
  const job = await claimNextJob()
  if (!job) return false

  console.log(`Claimed action job ${job.jobId} (${job.kind}) for ${job.codebaseId}`)
  try {
    const result = await executeJob(job)
    await completeJob(job, result)
  } catch (error) {
    await completeJob(job, {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Action job failed.',
    })
  }
  return true
}

async function executeJob(job) {
  const workspace = path.join(workspaceRoot, job.codebaseId)
  const jobEnv = actionJobEnv()
  const sharedArgs = [
    '--profile',
    'production',
    '--codebase-id',
    job.codebaseId,
    '--workspace-root',
    workspaceRoot,
    '--state-root',
    stateRoot,
    ...backendArgs(),
  ]

  const hydrate = await runProcess(process.execPath, [agentCli, 'hydrate', ...sharedArgs], {
    cwd: repoRoot,
    timeoutMs: 10 * 60 * 1000,
    env: trustedAgentEnv(),
  })
  if (hydrate.exitCode !== 0) return hydrate

  const prepared = await prepareWorkspaceDependencies(workspace, jobEnv)
  if (prepared.exitCode !== 0) return prepared

  return await runProcess(job.command, job.args ?? [], {
    cwd: workspace,
    timeoutMs: timeoutForJob(job),
    env: jobEnv,
  })
}

async function completeJob(job, result) {
  const ok = result.exitCode === 0
  await completeClaimedJob({
    jobId: job.jobId,
    runnerId,
    status: ok ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: ok ? `${job.kind} completed successfully.` : `${job.kind} failed with exit code ${result.exitCode}.`,
  })
  console.log(`Completed action job ${job.jobId}: ${ok ? 'succeeded' : 'failed'}`)
}

async function claimNextJob() {
  if (cloudBackend === 'd1') {
    return await d1Backend.claimNextActionJob({ runnerId })
  }
  return null
}

async function completeClaimedJob(payload) {
  if (cloudBackend === 'd1') {
    return await d1Backend.completeActionJob(payload)
  }
  throw new Error('No HopIt cloud backend is configured for action completion.')
}

async function prepareWorkspaceDependencies(workspace, env) {
  if (!existsSync(path.join(workspace, 'package.json'))) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    }
  }

  const hasPackageLock = existsSync(path.join(workspace, 'package-lock.json'))
  const args = hasPackageLock ? ['ci', '--ignore-scripts'] : ['install', '--ignore-scripts']
  return await runProcess('npm', args, {
    cwd: workspace,
    timeoutMs: 10 * 60 * 1000,
    env,
  })
}

function runProcess(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      stdout = capOutput(stdout + chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capOutput(stderr + chunk)
    })
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

function timeoutForJob(job) {
  if (job.kind === 'build') return 20 * 60 * 1000
  if (job.kind === 'test') return 15 * 60 * 1000
  return 10 * 60 * 1000
}

function trustedAgentEnv() {
  return {
    ...safeBaseEnv(),
    ...prefixedEnv('HOPIT_D1_'),
    ...prefixedEnv('CLOUDFLARE_'),
    ...prefixedEnv('HOPIT_BLOB_'),
    ...prefixedEnv('HOPIT_R2_'),
    ...prefixedEnv('HOPIT_B2_'),
    ...prefixedEnv('HOPIT_S3_'),
  }
}

function backendArgs() {
  if (cloudBackend === 'd1') return ['--cloud-backend', 'd1']
  return []
}

function configuredCloudBackend() {
  const preferred = process.env.HOPIT_CLOUD_BACKEND
  if (preferred === 'd1' || preferred === 'cloudflare-d1') return 'd1'
  if (isD1Configured()) return 'd1'
  return 'unavailable'
}

function actionJobEnv() {
  return {
    ...safeBaseEnv(),
    CI: '1',
    HOPIT_ACTION_JOB: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_cache: path.join(stateRoot, 'npm-cache'),
  }
}

function safeBaseEnv() {
  const env = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function prefixedEnv(prefix) {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith(prefix)),
  )
}

function capOutput(output) {
  return output.length > 20_000 ? output.slice(-20_000) : output
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
