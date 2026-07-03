// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { contentStorageMode, defaultOptions, entryKind, objectBlobProvider, r2DefaultFreeOnlyBudgetBytes, r2FreeStorageTierBytes } from '../constants.js'
import { clientEncryptionConfigFromOptions, prepareBlobPayload, shouldEncryptWithConfig, unwrapBlobPayload } from '@hopit/core/crypto'
import { bufferFromFileEntry, hashBuffer, hashContent, isObjectStoredFileEntry, normalizeCloudFileEntry, toCloudPath } from '../journal.js'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'

export function createObjectBlobStore(options) {
  const provider = normalizeBlobProvider(options['blob-provider'] ?? process.env.HOPIT_BLOB_PROVIDER)
  if (!provider) return null

  const prefix = normalizeBlobPrefix(options['blob-prefix'] ?? process.env.HOPIT_BLOB_PREFIX)
  const budget = blobBudgetOptions(options, provider)
  const encryptionConfig = clientEncryptionConfigFromOptions(options)

  if (provider === objectBlobProvider.filesystem) {
    const root = options['blob-root'] ?? process.env.HOPIT_BLOB_ROOT ?? path.join(path.dirname(options.cloud ?? defaultOptions.cloud), 'blobs')
    return new FilesystemBlobStore({ root, prefix, budget, encryptionConfig })
  }

  if (provider === objectBlobProvider.r2) {
    const accountId = requiredBlobConfig(options, 'r2-account-id', 'HOPIT_R2_ACCOUNT_ID')
    const bucket = requiredBlobConfig(options, 'r2-bucket', 'HOPIT_R2_BUCKET')
    const accessKeyId = requiredBlobConfig(options, 'r2-access-key-id', 'HOPIT_R2_ACCESS_KEY_ID')
    const secretAccessKey = requiredBlobConfig(options, 'r2-secret-access-key', 'HOPIT_R2_SECRET_ACCESS_KEY')
    const endpoint = options['r2-endpoint'] ?? process.env.HOPIT_R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`
    return new S3CompatibleBlobStore({
      provider,
      endpoint,
      bucket,
      region: options['r2-region'] ?? process.env.HOPIT_R2_REGION ?? 'auto',
      accessKeyId,
      secretAccessKey,
      prefix,
      forcePathStyle: true,
      budget,
      encryptionConfig,
    })
  }

  if (provider === objectBlobProvider.b2) {
    const bucket = requiredBlobConfig(options, 'b2-bucket', 'HOPIT_B2_BUCKET')
    const endpoint = requiredBlobConfig(options, 'b2-endpoint', 'HOPIT_B2_ENDPOINT')
    const accessKeyId = requiredBlobConfig(options, 'b2-key-id', 'HOPIT_B2_KEY_ID')
    const secretAccessKey = requiredBlobConfig(options, 'b2-application-key', 'HOPIT_B2_APPLICATION_KEY')
    return new S3CompatibleBlobStore({
      provider,
      endpoint,
      bucket,
      region: options['b2-region'] ?? process.env.HOPIT_B2_REGION ?? process.env.HOPIT_S3_REGION ?? 'us-west-004',
      accessKeyId,
      secretAccessKey,
      prefix,
      forcePathStyle: true,
      budget,
      encryptionConfig,
    })
  }

  const endpoint = requiredBlobConfig(options, 's3-endpoint', 'HOPIT_S3_ENDPOINT')
  const bucket = requiredBlobConfig(options, 's3-bucket', 'HOPIT_S3_BUCKET')
  const accessKeyId = requiredBlobConfig(options, 's3-access-key-id', 'HOPIT_S3_ACCESS_KEY_ID')
  const secretAccessKey = requiredBlobConfig(options, 's3-secret-access-key', 'HOPIT_S3_SECRET_ACCESS_KEY')
  return new S3CompatibleBlobStore({
    provider: objectBlobProvider.s3,
    endpoint,
    bucket,
    region: options['s3-region'] ?? process.env.HOPIT_S3_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    prefix,
    forcePathStyle: truthyEnv(options['s3-force-path-style'] ?? process.env.HOPIT_S3_FORCE_PATH_STYLE ?? '1'),
    budget,
    encryptionConfig,
  })
}

export function blobBudgetOptions(options, provider) {
  const freeOnly = blobFreeOnly(options, provider)
  const defaultBudget = provider === objectBlobProvider.r2 && freeOnly ? r2DefaultFreeOnlyBudgetBytes : null
  const budgetBytes = integerOption(
    options['blob-storage-budget-bytes'] ?? process.env.HOPIT_BLOB_STORAGE_BUDGET_BYTES,
    defaultBudget,
    'HOPIT_BLOB_STORAGE_BUDGET_BYTES',
  )
  return {
    freeOnly,
    budgetBytes,
  }
}

export function blobFreeOnly(options, provider) {
  const configured = options['blob-free-only'] ?? process.env.HOPIT_BLOB_FREE_ONLY
  if (configured === undefined) return provider === objectBlobProvider.r2
  return truthyEnv(configured)
}

export function integerOption(value, defaultValue, name) {
  if (value === undefined || value === null || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`)
  }
  return parsed
}

export function normalizeBlobProvider(value) {
  if (!value || value === 'inline') return null
  if (value === 'local' || value === 'fs' || value === objectBlobProvider.filesystem) return objectBlobProvider.filesystem
  if (value === objectBlobProvider.r2) return objectBlobProvider.r2
  if (value === objectBlobProvider.b2 || value === 'backblaze') return objectBlobProvider.b2
  if (value === objectBlobProvider.s3) return objectBlobProvider.s3
  throw new Error(`Unsupported HOPIT_BLOB_PROVIDER: ${value}`)
}

export function requiredBlobConfig(options, optionName, envName) {
  const value = options[optionName] ?? process.env[envName]
  if (!value) {
    throw new Error(`Object blob provider requires --${optionName} or ${envName}.`)
  }
  return value
}

export function normalizeBlobPrefix(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

export function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

export function blobKeyForHash(prefix, codebaseId, hash) {
  const safeCodebaseId = encodeURIComponent(String(codebaseId ?? 'hopit'))
  return [prefix, 'codebases', safeCodebaseId, 'blobs', 'sha256', hash.slice(0, 2), hash]
    .filter(Boolean)
    .join('/')
}

export function managedBlobPrefix(prefix, codebaseId) {
  const safeCodebaseId = encodeURIComponent(String(codebaseId ?? 'hopit'))
  return [prefix, 'codebases', safeCodebaseId, 'blobs', 'sha256']
    .filter(Boolean)
    .join('/')
}

export function isManagedBlobKey(key, prefix, codebaseId) {
  const root = managedBlobPrefix(prefix, codebaseId)
  const pattern = new RegExp(`^${escapeRegex(root)}/[0-9a-f]{2}/[0-9a-f]{64}$`)
  return pattern.test(key)
}

export function assertManagedBlobKey(key, prefix, codebaseId) {
  if (!isManagedBlobKey(key, prefix, codebaseId)) {
    throw new Error(`Refusing to delete unmanaged blob key: ${key}`)
  }
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function reachableBlobKeysForCloud(cloud) {
  const keys = new Set()
  for (const file of Object.values(cloud.files ?? {})) {
    if (file?.kind !== entryKind.file && file?.kind !== undefined) continue
    if (file?.contentStorage !== contentStorageMode.objectBlob) continue
    if (typeof file.blobKey === 'string' && file.blobKey) keys.add(file.blobKey)
  }
  return keys
}

export function storageRetentionMsFromOptions(options) {
  const days = options['retention-days'] ?? process.env.HOPIT_BLOB_GC_RETENTION_DAYS
  if (days !== undefined) {
    const parsed = Number(days)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('HOPIT_BLOB_GC_RETENTION_DAYS must be non-negative.')
    return parsed * 24 * 60 * 60 * 1000
  }
  const ms = options['retention-ms'] ?? process.env.HOPIT_BLOB_GC_RETENTION_MS
  if (ms !== undefined) {
    const parsed = Number(ms)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('HOPIT_BLOB_GC_RETENTION_MS must be non-negative.')
    return parsed
  }
  return 0
}

export class FilesystemBlobStore {
  constructor(options) {
    this.provider = objectBlobProvider.filesystem
    this.root = path.resolve(options.root)
    this.prefix = options.prefix ?? ''
    this.location = this.root
    this.budget = options.budget ?? { freeOnly: false, budgetBytes: null }
    this.usageCache = null
    this.encryptionConfig = options.encryptionConfig ?? null
  }

  shouldEncrypt(relativePath) {
    return shouldEncryptWithConfig(relativePath, this.encryptionConfig)
  }

  async putBlob({ codebaseId, relativePath, hash, buffer, encrypt = false }) {
    const prepared = prepareBlobPayload({
      codebaseId,
      relativePath,
      plaintextHash: hash,
      buffer,
      encrypt,
      encryptionConfig: this.encryptionConfig,
    })
    const key = blobKeyForHash(this.prefix, codebaseId, prepared.blobHash)
    const absolutePath = path.join(this.root, key)
    if (existsSync(absolutePath)) {
      const existing = await fs.readFile(absolutePath)
      if (hashBuffer(existing) !== prepared.blobHash) {
        throw new Error(`object_blob_hash_collision: existing filesystem blob differs for ${prepared.blobHash}.`)
      }
    } else {
      await this.assertWithinBudget(prepared.buffer.byteLength)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, prepared.buffer)
      if (this.usageCache) this.usageCache.bytes += prepared.buffer.byteLength
    }
    return {
      provider: this.provider,
      key,
      hash,
      size: buffer.byteLength,
      blobHash: prepared.blobHash,
      blobSize: prepared.buffer.byteLength,
      clientEncryption: prepared.clientEncryption,
      contentStorage: contentStorageMode.objectBlob,
    }
  }

  async getBlob(file, context = {}) {
    if (!file.blobKey) throw new Error('Object-backed file is missing blobKey.')
    const buffer = await fs.readFile(path.join(this.root, file.blobKey))
    return unwrapBlobPayload(buffer, file, context, this.encryptionConfig)
  }

  async listBlobs({ codebaseId }) {
    const root = path.join(this.root, managedBlobPrefix(this.prefix, codebaseId))
    const result = []
    const storeRoot = this.root

    async function walk(dir) {
      if (!existsSync(dir)) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolutePath)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(absolutePath)
        result.push({
          key: toCloudPath(path.relative(storeRoot, absolutePath)),
          size: stat.size,
          lastModified: stat.mtime.toISOString(),
        })
      }
    }

    await walk(root)
    return result
  }

  async deleteBlob(key, { codebaseId }) {
    assertManagedBlobKey(key, this.prefix, codebaseId)
    await fs.rm(path.join(this.root, key), { force: true })
    this.usageCache = null
  }

  async assertWithinBudget(additionalBytes) {
    if (!Number.isSafeInteger(this.budget.budgetBytes)) return
    const usage = await this.readUsage()
    if (usage.bytes + additionalBytes > this.budget.budgetBytes) {
      throw new Error(
        `object_blob_budget_exceeded: ${usage.bytes} existing bytes + ${additionalBytes} new bytes would exceed budget ${this.budget.budgetBytes}.`,
      )
    }
  }

  async readUsage() {
    if (this.usageCache) return this.usageCache
    const root = path.join(this.root, this.prefix)
    let bytes = 0
    let objects = 0

    async function walk(dir) {
      if (!existsSync(dir)) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolutePath)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(absolutePath)
        bytes += stat.size
        objects += 1
      }
    }

    await walk(root)
    this.usageCache = { bytes, objects }
    return this.usageCache
  }
}

export class S3CompatibleBlobStore {
  constructor(options) {
    this.provider = options.provider
    this.endpoint = new URL(options.endpoint)
    this.bucket = options.bucket
    this.region = options.region
    this.accessKeyId = options.accessKeyId
    this.secretAccessKey = options.secretAccessKey
    this.prefix = options.prefix ?? ''
    this.forcePathStyle = options.forcePathStyle !== false
    this.location = `${this.provider}:${this.bucket}`
    this.budget = options.budget ?? { freeOnly: false, budgetBytes: null }
    this.usageCache = null
    this.encryptionConfig = options.encryptionConfig ?? null
  }

  shouldEncrypt(relativePath) {
    return shouldEncryptWithConfig(relativePath, this.encryptionConfig)
  }

  async putBlob({ codebaseId, relativePath, hash, buffer, encrypt = false }) {
    const prepared = prepareBlobPayload({
      codebaseId,
      relativePath,
      plaintextHash: hash,
      buffer,
      encrypt,
      encryptionConfig: this.encryptionConfig,
    })
    const key = blobKeyForHash(this.prefix, codebaseId, prepared.blobHash)
    if (await this.exists(key)) {
      return {
        provider: this.provider,
        key,
        hash,
        size: buffer.byteLength,
        blobHash: prepared.blobHash,
        blobSize: prepared.buffer.byteLength,
        clientEncryption: prepared.clientEncryption,
        contentStorage: contentStorageMode.objectBlob,
      }
    }

    await this.assertWithinBudget(prepared.buffer.byteLength)
    await this.request('PUT', key, {
      body: prepared.buffer,
      headers: {
        'content-type': 'application/octet-stream',
      },
    })
    if (this.usageCache) this.usageCache.bytes += prepared.buffer.byteLength
    return {
      provider: this.provider,
      key,
      hash,
      size: buffer.byteLength,
      blobHash: prepared.blobHash,
      blobSize: prepared.buffer.byteLength,
      clientEncryption: prepared.clientEncryption,
      contentStorage: contentStorageMode.objectBlob,
    }
  }

  async getBlob(file, context = {}) {
    if (!file.blobKey) throw new Error('Object-backed file is missing blobKey.')
    const response = await this.request('GET', file.blobKey)
    const buffer = Buffer.from(await response.arrayBuffer())
    return unwrapBlobPayload(buffer, file, context, this.encryptionConfig)
  }

  async listBlobs({ codebaseId }) {
    const prefix = `${managedBlobPrefix(this.prefix, codebaseId)}/`
    let continuationToken = null
    const result = []

    do {
      const query = {
        'list-type': '2',
        prefix,
      }
      if (continuationToken) query['continuation-token'] = continuationToken
      const response = await this.request('GET', '', { query })
      const xml = await response.text()
      result.push(...parseS3ListObjects(xml))
      continuationToken = parseS3NextContinuationToken(xml)
    } while (continuationToken)

    return result
  }

  async deleteBlob(key, { codebaseId }) {
    assertManagedBlobKey(key, this.prefix, codebaseId)
    await this.request('DELETE', key)
    this.usageCache = null
  }

  async exists(key) {
    const response = await this.request('HEAD', key, { allowNotFound: true })
    return response.status !== 404
  }

  async assertWithinBudget(additionalBytes) {
    if (!Number.isSafeInteger(this.budget.budgetBytes)) return
    const usage = await this.readUsage()
    if (usage.bytes + additionalBytes > this.budget.budgetBytes) {
      const tierDetail = this.provider === objectBlobProvider.r2 && this.budget.freeOnly
        ? ` R2 free-only mode is capped at ${this.budget.budgetBytes} bytes below the ${r2FreeStorageTierBytes} byte free tier.`
        : ''
      throw new Error(
        `object_blob_budget_exceeded: ${usage.bytes} existing bytes + ${additionalBytes} new bytes would exceed budget ${this.budget.budgetBytes}.${tierDetail}`,
      )
    }
  }

  async readUsage() {
    if (this.usageCache) return this.usageCache
    const prefix = this.prefix ? `${this.prefix}/` : ''
    let continuationToken = null
    let bytes = 0
    let objects = 0

    do {
      const query = {
        'list-type': '2',
        prefix,
      }
      if (continuationToken) query['continuation-token'] = continuationToken
      const response = await this.request('GET', '', { query })
      const xml = await response.text()
      for (const size of parseS3ListObjectSizes(xml)) {
        bytes += size
        objects += 1
      }
      continuationToken = parseS3NextContinuationToken(xml)
    } while (continuationToken)

    this.usageCache = { bytes, objects }
    return this.usageCache
  }

  async request(method, key, options = {}) {
    const body = options.body ?? null
    const url = this.objectUrl(key)
    if (options.query) {
      const search = new URLSearchParams()
      for (const [name, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) search.set(name, String(value))
      }
      search.sort()
      url.search = search.toString()
    }
    const payloadHash = body ? hashBuffer(body) : hashContent('')
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.headers ?? {}),
    }
    const authorization = this.authorizationHeader({
      method,
      url,
      headers,
      payloadHash,
      amzDate,
      dateStamp,
    })
    headers.authorization = authorization

    const response = await fetch(url, {
      method,
      headers,
      body: body && method !== 'HEAD' ? body : undefined,
    })
    if (!response.ok && !(options.allowNotFound && response.status === 404)) {
      const detail = await safeResponseText(response)
      throw new Error(`${this.provider}_blob_request_failed: ${method} ${key} returned ${response.status}${detail ? ` ${detail}` : ''}`)
    }
    return response
  }

  objectUrl(key) {
    const encodedKey = encodeS3Key(key)
    if (this.forcePathStyle) {
      const url = new URL(this.endpoint.toString())
      url.pathname = joinUrlPath(url.pathname, this.bucket, encodedKey)
      return url
    }

    const url = new URL(this.endpoint.toString())
    url.hostname = `${this.bucket}.${url.hostname}`
    url.pathname = joinUrlPath(url.pathname, encodedKey)
    return url
  }

  authorizationHeader({ method, url, headers, payloadHash, amzDate, dateStamp }) {
    const canonicalHeaders = Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
      .sort(([a], [b]) => a.localeCompare(b))
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';')
    const canonicalRequest = [
      method,
      url.pathname || '/',
      url.search ? url.search.slice(1) : '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
      signedHeaders,
      payloadHash,
    ].join('\n')
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashContent(canonicalRequest),
    ].join('\n')
    const signingKey = awsV4SigningKey(this.secretAccessKey, dateStamp, this.region, 's3')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

export function parseS3ListObjectSizes(xml) {
  const sizes = []
  const contentMatches = xml.matchAll(/<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g)
  for (const match of contentMatches) {
    const sizeMatch = match[1].match(/<Size>(\d+)<\/Size>/)
    if (!sizeMatch) continue
    sizes.push(Number(sizeMatch[1]))
  }
  return sizes
}

export function parseS3ListObjects(xml) {
  const objects = []
  const contentMatches = xml.matchAll(/<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g)
  for (const match of contentMatches) {
    const keyMatch = match[1].match(/<Key>([\s\S]*?)<\/Key>/)
    if (!keyMatch) continue
    const sizeMatch = match[1].match(/<Size>(\d+)<\/Size>/)
    const modifiedMatch = match[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/)
    objects.push({
      key: decodeXmlText(keyMatch[1]),
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      lastModified: modifiedMatch ? decodeXmlText(modifiedMatch[1]) : null,
    })
  }
  return objects
}

export function parseS3NextContinuationToken(xml) {
  const match = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
  return match ? decodeXmlText(match[1]) : null
}

export function decodeXmlText(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

export function encodeS3Key(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function joinUrlPath(...parts) {
  return `/${parts
    .flatMap((part) => String(part ?? '').split('/'))
    .filter(Boolean)
    .join('/')}`
}

export function awsV4SigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update(service).digest()
  return createHmac('sha256', kService).update('aws4_request').digest()
}

export async function safeResponseText(response) {
  try {
    const text = await response.text()
    return text.trim().slice(0, 500)
  } catch {
    return ''
  }
}

export async function prepareGraphForBlobStorage(service, cloud) {
  if (!service.blobStore) return cloud
  const codebaseId = cloud.codebase?.id ?? service.codebaseId ?? 'hopit'
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    const entry = normalizeCloudFileEntry(relativePath, file)
    cloud.files[relativePath] = await prepareEntryForBlobStorage(service.blobStore, codebaseId, relativePath, entry)
  }
  return cloud
}

export async function prepareEntryForBlobStorage(blobStore, codebaseId, relativePath, entry) {
  const payload = normalizeCloudFileEntry(relativePath, entry)
  if (!blobStore || payload.kind !== entryKind.file || isObjectStoredFileEntry(payload)) return payload
  const buffer = bufferFromFileEntry(payload)
  const descriptor = await blobStore.putBlob({
    codebaseId,
    relativePath,
    hash: payload.hash,
    buffer,
    encrypt: blobStore.shouldEncrypt?.(relativePath) ?? false,
  })
  return {
    ...payload,
    content: '',
    contentStorage: contentStorageMode.objectBlob,
    blobProvider: descriptor.provider,
    blobKey: descriptor.key,
    blobHash: descriptor.blobHash ?? descriptor.hash,
    blobSize: descriptor.blobSize ?? descriptor.size,
    clientEncryption: descriptor.clientEncryption ?? null,
  }
}

