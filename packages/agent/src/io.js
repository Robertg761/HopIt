// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { CloudflareD1HopBackend, d1ConfigFromOptions, isD1Configured } from '@hopit/backend-d1'
import { randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'

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

export async function emit(options, event, detail) {
  const payload = {
    event,
    detail,
    at: new Date().toISOString(),
  }
  await appendNdjson(options.events, payload)
  await appendRemoteEvent(options, payload)
  if (!options.quiet) console.log(`${event} ${JSON.stringify(detail)}`)
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
