// @ts-check
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const __filename = fileURLToPath(import.meta.url)
export const __dirname = path.dirname(__filename)
export const fixturePath = path.resolve(__dirname, '../fixtures/demo-cloud.json')

export const defaultOptions = {
  cloud: '.hopit-agent/cloud.json',
  workspace: '.hopit-agent/workspaces/hopit-core',
  journal: '.hopit-agent/journal.ndjson',
  events: '.hopit-agent/events.ndjson',
  pid: '.hopit-agent/hopit.pid',
  host: '127.0.0.1',
  port: '4785',
}

export const workspaceMode = {
  adapter: 'managed-folder',
  cacheMode: 'local-cache',
  sourceOfTruth: 'cloud',
  materializationPolicy: 'metadata-first',
  hydrationPolicy: 'explicit-refresh-or-file',
  remoteUpdatePolicy: 'materialized-clean-only',
}

export const workspaceIndexVersion = 1
export const localCacheSchemaVersion = 1
export const cloudServiceType = 'fixture-json-cloud-graph'

export const fileScope = {
  shared: 'shared',
  ownerPrivate: 'owner-private',
}

export const entryKind = {
  file: 'file',
  symlink: 'symlink',
  directory: 'directory',
}

export const entryEncoding = {
  utf8: 'utf8',
  base64: 'base64',
}

export const contentStorageMode = {
  inline: 'inline',
  objectBlob: 'object-blob',
}

export const objectBlobProvider = {
  filesystem: 'filesystem',
  r2: 'r2',
  s3: 's3',
  b2: 'b2',
}

export const defaultFileStorageBudgetBytes = 1_000_000_000
export const r2FreeStorageTierBytes = 10_000_000_000
export const r2DefaultFreeOnlyBudgetBytes = 8_000_000_000
export const serviceReadyTimeoutMs = 60_000
export const serviceStatusFetchTimeoutMs = 5_000
export const defaultMirrorSecretRoutes = new Map([
  ['.env.local', '.private/env/repo-root/.env.local'],
])
export const mirrorSecretFileNames = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
])
export const mirrorNonSecretEnvSuffixes = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'default',
])
export const defaultLaunchAgentLabelPrefix = 'com.hopit.agent'

export class ConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}
