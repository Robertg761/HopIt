// @ts-check
// One agent per workspace (decisions doc §12): the agent that starts watching a
// workspace folder takes an exclusive lock on that folder for the lifetime of
// the watch. A second agent attaching to the same folder — whether a second
// `hop watch`, a second `hop service run`, or a completely separate profile/
// state-root pointed at the same folder — must refuse to start rather than
// have two watchers race to sync the same files. A lock left behind by a
// process that has since died (crash, kill -9, power loss) is detected via a
// liveness check on the recorded pid and taken over automatically so a dead
// holder never permanently wedges the workspace.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { emit } from './io.js'

export class WorkspaceLockError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'WorkspaceLockError'
    this.detail = detail
  }
}

/** Lockfile lives under the well-known `.hopit-agent/` marker directory inside
 * the workspace folder itself, so the lock travels with the folder regardless
 * of which state-root/codebase-id/session invoked the agent. `.hopit-agent`
 * is already excluded from workspace scans (see workspace-manifest.js), so
 * the lockfile is never journaled or synced as workspace content. */
export function workspaceLockPath(options, overrides = {}) {
  if (overrides.lockPath) return overrides.lockPath
  return path.join(path.resolve(options.workspace), '.hopit-agent', 'lock.json')
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but is owned by another user; that still
    // counts as alive. Any other error (most commonly ESRCH) means the pid is
    // gone.
    return error?.code === 'EPERM'
  }
}

export async function readWorkspaceLockRecord(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Lock-lifecycle events are best-effort observability, not a source of
// correctness: acquiring or releasing the lock must never fail (or leak a
// lock that was already granted) just because the events journal is
// unavailable or unconfigured.
async function emitSafely(options, event, detail) {
  try {
    await emit(options, event, detail)
  } catch {
    // best effort only
  }
}

function describeHolder(record) {
  if (!record) return 'another HopIt agent'
  const parts = [`pid ${record.pid}`]
  if (record.codebaseId) parts.push(`codebase "${record.codebaseId}"`)
  if (record.hostname) parts.push(`host "${record.hostname}"`)
  if (record.startedAt) parts.push(`started ${record.startedAt}`)
  return parts.join(', ')
}

/**
 * Acquire the exclusive workspace lock. Resolves with a handle exposing
 * `release()`. Throws `WorkspaceLockError` when the workspace is already held
 * by a live process (same host, pid still running).
 *
 * A lock recorded by a dead process (same host, pid no longer running) is
 * treated as stale and taken over. A lock recorded by a different host is
 * conservatively treated as live (liveness cannot be checked remotely).
 */
export async function acquireWorkspaceLock(options, overrides = {}) {
  const lockPath = workspaceLockPath(options, overrides)
  const hostname = overrides.hostname ?? os.hostname()
  const pid = overrides.pid ?? process.pid
  const holder = {
    pid,
    hostname,
    startedAt: new Date().toISOString(),
    codebaseId: options['codebase-id'] ?? null,
    sessionId: options['session-id'] ?? null,
    workspace: path.resolve(options.workspace),
  }

  await fs.mkdir(path.dirname(lockPath), { recursive: true })

  // At most one takeover attempt: if the retry still collides, either a live
  // holder won the race (correct refusal) or something is persistently wrong
  // (surface the error rather than loop forever).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle
    try {
      handle = await fs.open(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error

      const existing = await readWorkspaceLockRecord(lockPath)
      const staleLocally =
        existing && existing.hostname === hostname && !isProcessAlive(existing.pid)

      if (!staleLocally) {
        await emitSafely(options, 'watch.lock_blocked', {
          state: 'blocked',
          workspace: holder.workspace,
          lockPath,
          holder: existing,
        })
        throw new WorkspaceLockError(
          `Workspace ${holder.workspace} is already locked by ${describeHolder(existing)}. ` +
            'Stop that HopIt agent before starting another one on the same folder.',
          existing,
        )
      }

      // Stale lock left by a dead process on this host: remove and retry the
      // exclusive create. If another process wins the retry, the next loop
      // iteration will correctly see a live holder and refuse.
      await fs.rm(lockPath, { force: true })
      if (attempt === 0) {
        await emitSafely(options, 'watch.lock_takeover', {
          state: 'takeover',
          workspace: holder.workspace,
          lockPath,
          previousHolder: existing,
          newHolder: holder,
        })
      }
      continue
    }

    try {
      await handle.writeFile(JSON.stringify(holder, null, 2))
    } finally {
      await handle.close()
    }

    await emitSafely(options, 'watch.lock_acquired', {
      state: 'locked',
      workspace: holder.workspace,
      lockPath,
      holder,
    })

    let released = false
    return {
      path: lockPath,
      holder,
      async release() {
        if (released) return
        released = true
        const current = await readWorkspaceLockRecord(lockPath)
        // Only remove the lock if it is still ours; a stale-lock takeover by
        // another process must not be clobbered by our late release.
        if (current && current.pid === holder.pid && current.hostname === holder.hostname) {
          await fs.rm(lockPath, { force: true })
        }
      },
    }
  }

  throw new WorkspaceLockError(`Could not acquire workspace lock at ${lockPath} after a stale-lock takeover attempt.`)
}
