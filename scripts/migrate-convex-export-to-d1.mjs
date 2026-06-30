#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createD1Backend } from '../src/lib/d1-backend.js'

const args = parseArgs(process.argv.slice(2))
const exportPath = args.export
const codebaseId = args['codebase-id'] ?? process.env.HOPIT_CODEBASE_ID ?? 'hopit'
const eventLimit = args['all-events'] ? Infinity : Number(args['event-limit'] ?? 500)
const dryRun = Boolean(args['dry-run'])

if (!exportPath) {
  throw new Error('Usage: node scripts/migrate-convex-export-to-d1.mjs --export /path/to/convex-export.zip [--codebase-id hopit] [--dry-run]')
}
if (!Number.isFinite(eventLimit) && eventLimit !== Infinity) {
  throw new Error('--event-limit must be an integer.')
}

const codebaseRows = readJsonlFromZip(exportPath, 'codebases/documents.jsonl')
const codebase = codebaseRows.find((row) => row.codebaseId === codebaseId)
if (!codebase) {
  throw new Error(`Convex export does not contain codebase ${codebaseId}.`)
}

const fileRows = readJsonlFromZip(exportPath, 'files/documents.jsonl')
  .filter((row) => row.codebaseId === codebaseId)
  .sort((a, b) => a.path.localeCompare(b.path))
const eventRows = readJsonlFromZip(exportPath, 'agentEvents/documents.jsonl')
  .filter((row) => row.codebaseId === codebaseId)
  .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
const selectedEvents = eventLimit === Infinity ? eventRows : eventRows.slice(Math.max(0, eventRows.length - eventLimit))

const graph = {
  schemaVersion: codebase.schemaVersion,
  codebase: {
    id: codebase.codebaseId,
    name: codebase.name,
    ownerId: codebase.ownerId,
  },
  main: codebase.main,
  selectedState: codebase.selectedState,
  owner: codebase.owner,
  collaborators: Array.isArray(codebase.collaborators) ? codebase.collaborators : [],
  session: codebase.session,
  visibility: codebase.visibility,
  revision: codebase.revision,
  files: Object.fromEntries(fileRows.map((row) => [row.path, fileRowToGraphEntry(row)])),
}

const summary = {
  exportPath: path.resolve(exportPath),
  codebaseId,
  dryRun,
  files: fileRows.length,
  exportedEvents: eventRows.length,
  eventsToImport: selectedEvents.length,
  revision: graph.revision,
}

if (dryRun) {
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2))
  process.exit(0)
}

const backend = createD1Backend({ 'codebase-id': codebaseId })
await backend.ensureSchema()
await backend.writeGraph(graph)
for (const event of selectedEvents) {
  await backend.appendEvent({
    codebaseId,
    event: event.event,
    detail: event.detail ?? {},
    at: event.at,
    source: event.source ?? 'convex-export',
  })
}

console.log(JSON.stringify({ ok: true, ...summary }, null, 2))

function readJsonlFromZip(zipPath, entryName) {
  const result = spawnSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`Unable to read ${entryName} from ${zipPath}: ${result.stderr || result.stdout}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function fileRowToGraphEntry(row) {
  return {
    kind: row.kind ?? 'file',
    content: row.content ?? '',
    encoding: row.encoding ?? 'utf8',
    target: row.target ?? null,
    blobHash: row.blobHash ?? row.hash ?? null,
    blobProvider: row.blobProvider ?? null,
    blobKey: row.blobKey ?? null,
    blobSize: row.blobSize ?? null,
    clientEncryption: row.clientEncryption ?? null,
    encryption: row.encryption ?? null,
    privacyZone: row.privacyZone ?? privacyZoneForPath(row.path),
    zoneId: row.zoneId ?? `${row.codebaseId}:${privacyZoneForPath(row.path)}`,
    contentStorage: row.contentStorage ?? 'inline',
    hash: row.hash ?? null,
    size: row.size ?? byteLength(row.content ?? ''),
    scope: row.scope ?? scopeForPath(row.path),
    revision: row.revision,
    updatedAt: row.updatedAt,
  }
}

function scopeForPath(filePath) {
  return filePath === '.private' || filePath.startsWith('.private/') ? 'owner-private' : 'shared'
}

function privacyZoneForPath(filePath) {
  if (filePath === '.private/env' || filePath.startsWith('.private/env/')) return 'secrets'
  if (filePath === '.private/git' || filePath.startsWith('.private/git/')) return 'git-internals'
  if (scopeForPath(filePath) === 'owner-private') return 'owner-private'
  return 'repo-content'
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'dry-run' || key === 'all-events') {
      options[key] = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = value
    index += 1
  }
  return options
}
