// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { CloudflareD1HopBackend, d1ConfigFromOptions, isD1Configured } from '@hopit/backend-d1'
import { randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import { humanOutputMode, reportEvent } from './output.js'

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'local-project'
}

export async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

export async function readNdjson(filePath) {
  if (!existsSync(filePath)) return []

  const content = await fs.readFile(filePath, 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, filePath)
}

export async function writeSecureJson(filePath, value) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await chmodIfSupported(dir, 0o700)
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmodIfSupported(tempPath, 0o600)
  await fs.rename(tempPath, filePath)
  await chmodIfSupported(filePath, 0o600)
}

export async function chmodIfSupported(filePath, mode) {
  if (process.platform === 'win32') return
  await fs.chmod(filePath, mode)
}

export async function appendNdjson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

// Default size ceiling for the events journal before it is rotated. The events
// file grows one line per emitted event and, left unbounded, reaches tens of
// megabytes within weeks (production hit >52 MB in ~3 weeks). Rotation keeps at
// most two generations on disk, so total on-disk cost is bounded at ~2x this.
export const DEFAULT_EVENTS_MAX_BYTES = 16 * 1024 * 1024

// Resolve the events-file rotation threshold, allowing an env override. Invalid
// or non-positive values fall back to the default so a bad env var can never
// disable rotation or truncate on every write.
export function eventsMaxBytes() {
  const raw = process.env.HOPIT_EVENTS_MAX_BYTES
  if (raw === undefined || raw === '') return DEFAULT_EVENTS_MAX_BYTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVENTS_MAX_BYTES
  return Math.floor(parsed)
}

// The single retained previous generation lives next to the active file as
// `<name>.1.ndjson`. e.g. `events/hopit.ndjson` -> `events/hopit.1.ndjson`.
export function rotatedNdjsonPath(filePath) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const ext = '.ndjson'
  const stem = base.endsWith(ext) ? base.slice(0, -ext.length) : base
  return path.join(dir, `${stem}.1${ext}`)
}

// Rotate the events file when it reaches the threshold: rename the current file
// to `<name>.1.ndjson`, atomically replacing any prior generation so exactly one
// is ever retained. The atomic rename (rather than delete-then-rename) closes
// the window where a racing one-shot CLI emit could observe a missing file, and
// re-stat'ing immediately before the rename means a second concurrent emitter
// that already saw the file rotated away (now small) will not rotate a fresh
// file. The single-writer service is the common case; this is belt-and-braces
// for the rare concurrent one-shot command. Returns true when rotation happened.
export async function rotateEventsIfNeeded(filePath, maxBytes = eventsMaxBytes()) {
  let size
  try {
    size = (await fs.stat(filePath)).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (size < maxBytes) return false
  const rotatedPath = rotatedNdjsonPath(filePath)
  try {
    await fs.rename(filePath, rotatedPath)
  } catch (error) {
    // A concurrent emitter rotated it out from under us; nothing to lose.
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  return true
}

// Append an event line, rotating BEFORE the append so the event that trips the
// threshold always lands in the fresh current file and is never lost.
export async function appendEventNdjson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await rotateEventsIfNeeded(filePath)
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

// Read the events journal including the one rotated generation, oldest first,
// for readers that need history deeper than the current file (e.g. resuming
// remote-push cursors: the last push event may sit in the rotated generation
// right after a rotation). Recent-window readers do NOT need this. The newest
// events always live in the current file, so they can keep using readNdjson.
export async function readEventsWithHistory(filePath) {
  const [rotated, current] = await Promise.all([
    readNdjson(rotatedNdjsonPath(filePath)),
    readNdjson(filePath),
  ])
  return rotated.concat(current)
}

export async function emit(options, event, detail) {
  const payload = {
    event,
    detail,
    at: new Date().toISOString(),
  }
  await appendEventNdjson(options.events, payload)
  await appendRemoteEvent(options, payload)
  if (options.quiet) return
  // Human commands render concise progress; everything else (daemons, --json,
  // machine consumers) keeps the exact raw event line on stdout as before. The
  // events journal above records every event regardless of output mode.
  if (humanOutputMode(options)) {
    reportEvent(options, event, detail)
  } else {
    console.log(`${event} ${JSON.stringify(detail)}`)
  }
}

export async function appendRemoteEvent(options, payload) {
  if (shouldUseD1Backend(options)) {
    await appendD1Event(options, payload)
  }
}

export async function appendD1Event(options, payload) {
  const codebaseId = codebaseIdFromEvent(options, payload.detail)
  if (!codebaseId) return

  try {
    const backend = new CloudflareD1HopBackend(d1ConfigFromOptions({
      ...options,
      'codebase-id': codebaseId,
    }))
    await backend.appendEvent({
      codebaseId,
      event: payload.event,
      detail: payload.detail,
      at: payload.at,
      source: 'local-agent',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown D1 event error'
    console.error(`d1.event_failed ${JSON.stringify({ event: payload.event, reason: message })}`)
  }
}

export function codebaseIdFromEvent(options, detail) {
  return (
    detail?.contract?.codebaseId ??
    detail?.codebaseId ??
    options['codebase-id'] ??
    process.env.HOPIT_CODEBASE_ID ??
    null
  )
}

export function cloudBackendPreference(options) {
  return options['cloud-backend'] ?? process.env.HOPIT_CLOUD_BACKEND ?? null
}

export function shouldUseD1Backend(options) {
  const preference = cloudBackendPreference(options)
  if (preference === 'd1' || preference === 'cloudflare-d1') return true
  if (preference === 'fixture' || preference === 'local') return false
  return isD1Configured(options)
}

export function agentSessionTokenFromOptions(options) {
  return options['session-token'] ?? process.env.HOPIT_AGENT_SESSION_TOKEN ?? null
}

export function sessionCapabilitiesFromOptions(options) {
  const raw = options.capabilities ?? process.env.HOPIT_AGENT_SESSION_CAPABILITIES
  if (!raw) return ['read', 'write', 'sync', 'watch']
  return String(raw)
    .split(',')
    .map((capability) => capability.trim())
    .filter(Boolean)
}

export function supportsAgentSessions(cloudService) {
  return Boolean(
    cloudService &&
    typeof cloudService.registerAgentSession === 'function' &&
    typeof cloudService.listAgentSessions === 'function' &&
    typeof cloudService.touchAgentSession === 'function' &&
    typeof cloudService.revokeAgentSession === 'function',
  )
}

export function supportsKeyRegistration(cloudService) {
  return Boolean(
    cloudService &&
    typeof cloudService.registerDeviceKey === 'function' &&
    typeof cloudService.ensureUserKeyring === 'function' &&
    typeof cloudService.createWrappedKey === 'function',
  )
}

export function findLastEvent(events, eventName) {
  return events.findLast((entry) => entry.event === eventName) ?? null
}

export function findLastEventOf(events, eventNames) {
  const names = new Set(eventNames)
  return events.findLast((entry) => names.has(entry.event)) ?? null
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}
