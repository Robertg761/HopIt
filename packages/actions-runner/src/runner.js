#!/usr/bin/env node
// GR-B5: CI on propose (actions-runner hardening). This module is split into
// two layers:
//
//  - `createActionsRunner(config)` -- a pure, dependency-injected factory
//    (backend, spawn function, sleep function, clocks all overridable) so
//    `packages/agent/test/actions-runner.test.js` can exercise claim ->
//    hydrate -> run -> complete, failure/timeout/output-cap, env lockdown,
//    and claim retry/backoff without a real D1 database or a real hosted
//    process pool.
//  - The CLI entrypoint at the bottom, guarded so importing this module for
//    tests never starts polling or throws on a missing cloud backend.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createD1Backend, isD1Configured } from '@hopit/backend-d1'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const defaultAgentCli = path.join(repoRoot, 'packages/agent/src/cli.js')

export const defaultClaimRetry = { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 5000 }
export const defaultOutputCapBytes = 20_000

/**
 * @param {object} config
 * @param {object} config.backend - object with `claimNextActionJob` and
 *   `completeActionJob` (the shape `@hopit/backend-d1` produces).
 */
export function createActionsRunner(config = {}) {
  const {
    backend,
    runnerId = `${os.hostname()}-${process.pid}`,
    cloudBackendName = 'd1',
    agentCli = defaultAgentCli,
    workspaceRoot = path.join(os.tmpdir(), 'hopit-actions-workspaces'),
    stateRoot = path.join(os.tmpdir(), 'hopit-actions-state'),
    pollIntervalMs = 5000,
    claimRetry = defaultClaimRetry,
    outputCapBytes = defaultOutputCapBytes,
    env = process.env,
    backendArgs = () => (cloudBackendName === 'd1' ? ['--cloud-backend', 'd1'] : []),
    spawnFn = spawn,
    sleepFn = sleep,
    logger = console,
  } = config

  if (!backend) throw new Error('createActionsRunner requires a backend.')

  async function runLoop() {
    logger.log(`HopIt actions runner ${runnerId} polling ${cloudBackendName}`)
    for (;;) {
      try {
        await runOnce()
      } catch (error) {
        // Claim retries are already exhausted inside claimNextJobWithRetry --
        // this only fires if every retry attempt failed. Log and keep
        // polling rather than let one bad cycle kill the whole runner
        // process.
        logger.error?.(`Action runner cycle failed: ${error instanceof Error ? error.message : error}`)
      }
      await sleepFn(pollIntervalMs)
    }
  }

  async function runOnce() {
    const job = await claimNextJobWithRetry()
    if (!job) return false

    logger.log(`Claimed action job ${job.jobId} (${job.kind}) for ${job.codebaseId}`)
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

  // GR-B5 Do item: "add retry/backoff on claim errors." A claim error is
  // infrastructure trouble (D1 unreachable, transient 5xx, etc.), not "no
  // work available" (`claimNextActionJob` returning `null` is not an
  // error). Retries with exponential backoff up to `claimRetry.maxAttempts`
  // before giving up for this cycle.
  async function claimNextJobWithRetry() {
    let attempt = 0
    let lastError = null
    while (attempt < claimRetry.maxAttempts) {
      try {
        return await backend.claimNextActionJob({ runnerId })
      } catch (error) {
        lastError = error
        attempt += 1
        if (attempt >= claimRetry.maxAttempts) break
        const delay = Math.min(claimRetry.baseDelayMs * 2 ** (attempt - 1), claimRetry.maxDelayMs)
        logger.warn?.(
          `Claim attempt ${attempt}/${claimRetry.maxAttempts} failed (${error instanceof Error ? error.message : error}); retrying in ${delay}ms`,
        )
        await sleepFn(delay)
      }
    }
    throw lastError ?? new Error('Failed to claim next action job.')
  }

  async function executeJob(job) {
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

    // GR-E2: mirror-push jobs build their commits straight from the
    // codebase's own content hashes -- there is no npm-installed workspace
    // checkout to hydrate/prepare.
    if (job.kind === 'mirror') {
      return await runProcess(process.execPath, [agentCli, 'mirror-sync', ...sharedArgs], {
        cwd: repoRoot,
        timeoutMs: 10 * 60 * 1000,
        env: trustedAgentEnv(env),
        outputCapBytes,
      })
    }

    const workspace = path.join(workspaceRoot, job.codebaseId)
    const jobEnv = actionJobEnv({ stateRoot, env })

    const hydrate = await runProcess(process.execPath, [agentCli, 'hydrate', ...sharedArgs], {
      cwd: repoRoot,
      timeoutMs: 10 * 60 * 1000,
      env: trustedAgentEnv(env),
      outputCapBytes,
    })
    if (hydrate.exitCode !== 0) return hydrate

    const prepared = await prepareWorkspaceDependencies(workspace, jobEnv)
    if (prepared.exitCode !== 0) return prepared

    return await runProcess(job.command, job.args ?? [], {
      cwd: workspace,
      timeoutMs: timeoutForJob(job),
      env: jobEnv,
      outputCapBytes,
    })
  }

  async function completeJob(job, result) {
    const ok = result.exitCode === 0
    await backend.completeActionJob({
      jobId: job.jobId,
      runnerId,
      status: ok ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: ok ? `${job.kind} completed successfully.` : `${job.kind} failed with exit code ${result.exitCode}.`,
    })
    logger.log(`Completed action job ${job.jobId}: ${ok ? 'succeeded' : 'failed'}`)
  }

  async function prepareWorkspaceDependencies(workspace, jobEnv) {
    if (!existsSync(path.join(workspace, 'package.json'))) {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const hasPackageLock = existsSync(path.join(workspace, 'package-lock.json'))
    const args = hasPackageLock ? ['ci', '--ignore-scripts'] : ['install', '--ignore-scripts']
    return await runProcess('npm', args, { cwd: workspace, timeoutMs: 10 * 60 * 1000, env: jobEnv, outputCapBytes })
  }

  function runProcess(command, args, { cwd, timeoutMs, env: processEnv, outputCapBytes: capBytes = outputCapBytes }) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(command, args, {
        cwd,
        env: processEnv,
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
        stdout = capOutput(stdout + chunk, capBytes)
      })
      child.stderr.on('data', (chunk) => {
        stderr = capOutput(stderr + chunk, capBytes)
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

  return { runOnce, runLoop, executeJob, claimNextJobWithRetry, runProcess, runnerId }
}

export function timeoutForJob(job) {
  if (job.kind === 'build') return 20 * 60 * 1000
  if (job.kind === 'test' || job.kind === 'ci') return 15 * 60 * 1000
  return 10 * 60 * 1000
}

// The job step's environment (used to run the actual lint/test/build/ci
// command). Deliberately built from `safeBaseEnv` only, never
// `trustedAgentEnv` -- untrusted job code (a contributor's own repo
// content, or npm postinstall/test scripts) must never see cloud
// credentials. See `env-lockdown` in actions-runner.test.js.
export function actionJobEnv({ stateRoot = path.join(os.tmpdir(), 'hopit-actions-state'), env = process.env } = {}) {
  return {
    ...safeBaseEnv(env),
    CI: '1',
    HOPIT_ACTION_JOB: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_cache: path.join(stateRoot, 'npm-cache'),
  }
}

// The environment used for the runner's own trusted steps (hydrate,
// mirror-sync) -- these need cloud credentials to talk to D1/blob storage.
export function trustedAgentEnv(env = process.env) {
  return {
    ...safeBaseEnv(env),
    ...prefixedEnv(env, 'HOPIT_D1_'),
    ...prefixedEnv(env, 'CLOUDFLARE_'),
    ...prefixedEnv(env, 'HOPIT_BLOB_'),
    ...prefixedEnv(env, 'HOPIT_R2_'),
    ...prefixedEnv(env, 'HOPIT_B2_'),
    ...prefixedEnv(env, 'HOPIT_S3_'),
    // GR-E2: needed only to decrypt a configured mirror deploy key
    // (client-encrypted at rest, same rule as `.private/env/`).
    ...prefixedEnv(env, 'HOPIT_CLIENT_ENCRYPTION_'),
  }
}

export function safeBaseEnv(env = process.env) {
  const out = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (env[name]) out[name] = env[name]
  }
  return out
}

function prefixedEnv(env, prefix) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith(prefix)))
}

export function capOutput(output, capBytes = defaultOutputCapBytes) {
  return output.length > capBytes ? output.slice(-capBytes) : output
}

export function configuredCloudBackend(env = process.env) {
  const preferred = env.HOPIT_CLOUD_BACKEND
  if (preferred === 'd1' || preferred === 'cloudflare-d1') return 'd1'
  if (isD1Configured({}, env)) return 'd1'
  return 'unavailable'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- CLI entrypoint -------------------------------------------------------
// Guarded so `import`ing this module (as the test suite does) never runs
// the polling loop or throws on a missing cloud backend.
const isMainModule = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMainModule) {
  await main()
}

async function main() {
  const cloudBackendName = configuredCloudBackend()
  if (cloudBackendName === 'unavailable') {
    throw new Error('Set HOPIT_CLOUD_BACKEND=d1 with HOPIT_D1_* values for the actions runner.')
  }
  const backend = createD1Backend()
  const runner = createActionsRunner({
    backend,
    cloudBackendName,
    runnerId: process.env.HOPIT_ACTION_RUNNER_ID,
    workspaceRoot: process.env.HOPIT_ACTION_WORKSPACE_ROOT,
    stateRoot: process.env.HOPIT_ACTION_STATE_ROOT,
    pollIntervalMs: Number(process.env.HOPIT_ACTION_POLL_INTERVAL_MS ?? 5000),
  })

  const mode = process.argv[2] ?? 'run-once'
  if (mode === 'loop') {
    await runner.runLoop()
  } else if (mode === 'run-once') {
    const ran = await runner.runOnce()
    if (!ran) console.log('No queued HopIt action jobs.')
  } else {
    throw new Error(`Unknown actions runner mode: ${mode}`)
  }
}
