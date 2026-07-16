// @ts-check
// Spawn the installed `hop` CLI for all side-effecting actions. The desktop app
// never reimplements agent logic; it shells out to the same binary the user runs
// by hand. Human-readable output (HOPIT_JSON=0) is streamed to the UI log pane;
// the env file is autoloaded by hop itself so spawns target the production
// profile exactly like an interactive shell.

import { spawn } from 'node:child_process'
import { assertSafeAbsolutePath, assertSafeCodebaseId } from './paths.js'

/**
 * Build the sanitized environment for a hop spawn.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{ humanMode?: boolean }} [opts]
 */
export function hopSpawnEnv(baseEnv, opts = {}) {
  const { humanMode = true } = opts
  return { ...baseEnv, HOPIT_JSON: humanMode ? '0' : '1' }
}

/**
 * Stream a hop command, delivering output line-by-line. Resolves with the exit
 * code. Both stdout and stderr are forwarded (hop renders human progress on
 * stderr for interactive commands).
 * @param {string} hopBin
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, humanMode?: boolean, onLine?: (line: string) => void }} [opts]
 * @returns {Promise<{ code: number|null }>}
 */
export function streamHop(hopBin, args, opts = {}) {
  const { env = process.env, humanMode = true, onLine } = opts
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(hopBin, args, { env: hopSpawnEnv(env, { humanMode }), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let buffer = ''
    const pump = (data) => {
      buffer += data.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (onLine) onLine(stripAnsi(line))
        index = buffer.indexOf('\n')
      }
    }
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    // A broken pipe (hop dies mid-stream) can surface as an 'error' on the stdio
    // streams; without a listener Node would throw an uncaught exception. Fold it
    // into the child 'error'/'close' path instead.
    child.stdout.on('error', reject)
    child.stderr.on('error', reject)
    child.on('error', reject)
    child.on('close', (code) => {
      if (buffer.length && onLine) onLine(stripAnsi(buffer))
      resolve({ code })
    })
  })
}

/**
 * Run a hop command in JSON mode and parse the last JSON object from stdout.
 * @param {string} hopBin
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number|null, json: any, stdout: string, stderr: string }>}
 */
export function runHopJson(hopBin, args, opts = {}) {
  const { env = process.env } = opts
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(hopBin, args, { env: hopSpawnEnv(env, { humanMode: false }), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data.toString()))
    child.stderr.on('data', (data) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, json: parseLastJson(stdout), stdout, stderr })
    })
  })
}

/** Argument builders keep IPC-supplied values validated before they reach spawn. */
export function syncArgs(codebaseId) {
  return ['sync', '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

export function refreshArgs(codebaseId) {
  return ['refresh', '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

export function serviceArgs(action, codebaseId) {
  const allowed = new Set(['start', 'stop', 'restart', 'status'])
  if (!allowed.has(action)) throw new Error(`Unsupported service action: ${action}`)
  return ['service', action, '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

export function addArgs({ source, codebaseId }) {
  const args = ['add', '--source', assertSafeAbsolutePath(source)]
  if (codebaseId) args.push('--codebase-id', assertSafeCodebaseId(codebaseId))
  return args
}

/**
 * Hydrate a single file or a path prefix. The agent verb differs (hydrate-file
 * vs hydrate-path); `recursive` only applies to hydrate-path.
 */
export function hydratePathArgs({ codebaseId, cloudPath, recursive = false, withSiblings = false }) {
  const id = assertSafeCodebaseId(codebaseId)
  const p = assertSafeCloudPath(cloudPath)
  if (recursive) {
    const args = ['workspace', 'hydrate-path', '--path', p, '--codebase-id', id]
    args.push('--recursive')
    return args
  }
  const args = ['workspace', 'hydrate-file', '--path', p, '--codebase-id', id]
  if (withSiblings) args.push('--with-siblings')
  return args
}

/** Pin or unpin a cloud path so its local body is protected from pruning. */
export function pinArgs({ codebaseId, cloudPath, pinned }) {
  const id = assertSafeCodebaseId(codebaseId)
  const p = assertSafeCloudPath(cloudPath)
  return ['workspace', pinned ? 'pin' : 'unpin', '--path', p, '--codebase-id', id]
}

/**
 * Build `hop compare --from <rev> --to <rev> [--path <file>] --codebase-id <id>`.
 * Directory compare (no cloudPath) is metadata-only and fetches zero blob bodies;
 * a cloudPath opens exactly one file's line diff. Revisions are coerced to safe
 * integers so no IPC-supplied string can inject extra tokens; the codebase id and
 * path go through the same validators as every other spawn.
 * @param {{ codebaseId: string, fromRevision: unknown, toRevision: unknown, cloudPath?: string|null }} params
 */
export function compareArgs({ codebaseId, fromRevision, toRevision, cloudPath }) {
  const id = assertSafeCodebaseId(codebaseId)
  const from = assertSafeRevision(fromRevision, '--from')
  const to = assertSafeRevision(toRevision, '--to')
  const args = ['compare', '--from', String(from), '--to', String(to), '--codebase-id', id]
  if (cloudPath != null && cloudPath !== '') {
    args.push('--path', assertSafeCloudPath(cloudPath))
  }
  return args
}

/**
 * Build `hop trail episodes --codebase-id <id> --json`. Read-only: lists the
 * clustered trail episodes with their (possibly null) AI labels. JSON is forced
 * by the HOPIT_JSON=1 env `runHopJson` sets, so no `--json` flag is needed.
 * @param {string} codebaseId
 */
export function trailEpisodesArgs(codebaseId) {
  return ['trail', 'episodes', '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

/**
 * Build a read-only probe of the per-codebase summaries setting via a dry-run
 * summarize: `hop trail summarize --dry-run --limit 1 --codebase-id <id>`. A dry
 * run enforces the opt-in gate (returns state:'disabled' when off) and, when on,
 * reports the mode WITHOUT contacting the provider or needing an API key: and
 * `--limit 1` bounds the work it does to build a would-send payload. This is the
 * honest way to read on/off + mode without a GUI toggle or a real model call.
 * @param {string} codebaseId
 */
export function trailSummariesProbeArgs(codebaseId) {
  return ['trail', 'summarize', '--dry-run', '--limit', '1', '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

/**
 * Build `hop trail summarize --codebase-id <id>`: the real "Summarize now" run.
 * Server-gated: fails closed when summaries are off, and surfaces an honest error
 * (e.g. missing key) rather than sending anything. No GUI flip of the setting.
 * @param {string} codebaseId
 */
export function trailSummarizeArgs(codebaseId) {
  return ['trail', 'summarize', '--codebase-id', assertSafeCodebaseId(codebaseId)]
}

/**
 * A revision is a non-negative safe integer. Coerce+validate so a hostile string
 * (e.g. "1 --exec") can never survive to the argv.
 * @param {unknown} candidate
 * @param {string} [name]
 */
export function assertSafeRevision(candidate, name = 'revision') {
  const value =
    typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && candidate.trim() !== ''
        ? Number(candidate)
        : Number.NaN
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} revision: ${candidate}`)
  }
  return value
}

/**
 * A cloud path is a workspace-relative POSIX path. Reject absolute paths,
 * traversal, and null bytes before it reaches the CLI.
 * @param {unknown} candidate
 */
export function assertSafeCloudPath(candidate) {
  const value = typeof candidate === 'string' ? candidate.trim().replace(/\\/g, '/') : ''
  if (!value) throw new Error('A file path is required.')
  if (value.includes('\0')) throw new Error('Path contains a null byte.')
  if (value.startsWith('/')) throw new Error(`Path must be workspace-relative: ${candidate}`)
  if (value.split('/').some((segment) => segment === '..')) {
    throw new Error(`Path may not traverse upward: ${candidate}`)
  }
  return value
}

function parseLastJson(text) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split('\n').filter((line) => line.trim())
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i])
      } catch {
        // keep scanning earlier lines
      }
    }
    return null
  }
}

// Built from a char code so the source file carries no literal control byte.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
function stripAnsi(line) {
  return line.replace(ANSI_PATTERN, '')
}
