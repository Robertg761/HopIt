// R2 blob broker — Phase 3 Stage 1b (HOPIT_MULTITENANT / Front 2)
//
// Today the agent writes/reads R2 object blobs CLIENT-SIDE with ACCOUNT-LEVEL S3
// credentials (packages/agent/src/blob-stores). Blob keys are codebase-namespaced
// (codebases/<encoded-id>/blobs/...), but a client that holds those account keys
// can reach ANY tenant's prefix. For strangers that is a cross-tenant blob-access
// gap (design §1.3, §2d Front 2).
//
// This module is the pure, testable core of the broker the Worker exposes behind
// HOPIT_MULTITENANT: given a caller entitled to exactly one codebase prefix, it
// (a) refuses any key outside that prefix and (b) mints a short-lived, per-object,
// method-scoped SigV4 *presigned URL* so the client can do a single raw GET/PUT
// without ever holding the account credentials. Because the signature covers the
// exact object path and HTTP method, a returned URL cannot be widened to another
// codebase, and a request for a foreign key never gets signed at all.
//
// The Worker holds the only copy of the R2 credentials (as Worker secrets); no
// tenant client does. GC / usage enumeration (which need a bucket-wide LIST) stay
// an admin/server-side operation on the direct-credential path, off the tenant
// client path — see the design §2d addendum.

export const brokerPresignPath = '/blob-presign'
export const brokerAllowedMethods = new Set(['GET', 'PUT', 'HEAD'])
export const defaultBrokerTtlSeconds = 120

export function isBrokerPresignPath(pathname) {
  return pathname === brokerPresignPath || pathname.endsWith(brokerPresignPath)
}

export function normalizeBrokerPrefix(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

export function normalizeBrokerMethod(method) {
  const normalized = String(method ?? '').trim().toUpperCase()
  if (!brokerAllowedMethods.has(normalized)) {
    throw new Error(`Broker cannot presign method ${method}.`)
  }
  return normalized
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The one isolation invariant: a key is only ever signable if it is the managed
// blob key of the codebase the caller is entitled to. Mirrors the agent's
// isManagedBlobKey (packages/agent/src/blob-stores/index.js) so the two ends agree
// byte-for-byte on the namespace. The Worker's HOPIT_BLOB_PREFIX must equal the
// agent's HOPIT_BLOB_PREFIX.
export function brokerManagedKeyPattern(codebaseId, prefix) {
  const encoded = escapeRegex(encodeURIComponent(String(codebaseId ?? '')))
  const normalizedPrefix = normalizeBrokerPrefix(prefix)
  const prefixPart = normalizedPrefix ? `${escapeRegex(normalizedPrefix)}/` : ''
  return new RegExp(`^${prefixPart}codebases/${encoded}/blobs/sha256/[0-9a-f]{2}/[0-9a-f]{64}$`)
}

export function isBrokerKeyForCodebase(key, codebaseId, prefix) {
  if (typeof key !== 'string' || !key) return false
  if (key.includes('..') || key.includes('//') || key.includes('\\')) return false
  return brokerManagedKeyPattern(codebaseId, prefix).test(key)
}

export function assertBrokerKeyForCodebase(key, codebaseId, prefix) {
  if (!codebaseId) throw new Error('Broker requires an entitled codebase.')
  if (!isBrokerKeyForCodebase(key, codebaseId, prefix)) {
    // Never echo the requested key back verbatim — it can be attacker-chosen.
    throw new Error('Broker refuses a blob key outside the entitled codebase prefix.')
  }
}

// --- SigV4 query-string presigning (WebCrypto, Worker-safe) ------------------

function awsUriEncode(value, encodeSlash = true) {
  const bytes = new TextEncoder().encode(String(value))
  let out = ''
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d /* - */ ||
      byte === 0x2e /* . */ ||
      byte === 0x5f /* _ */ ||
      byte === 0x7e /* ~ */
    if (isUnreserved) {
      out += String.fromCharCode(byte)
    } else if (byte === 0x2f /* / */ && !encodeSlash) {
      out += '/'
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

function toAmzDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

async function sha256Hex(message) {
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : message
  const digest = await crypto.subtle.digest('SHA-256', data)
  return hex(new Uint8Array(digest))
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

function hex(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

function objectPath(bucket, key, forcePathStyle) {
  // R2 presigned URLs use path-style (forcePathStyle) — the agent's direct S3
  // client does too (blob-stores index.js forcePathStyle: true).
  if (forcePathStyle) return awsUriEncode(`/${bucket}/${key}`, false)
  return awsUriEncode(`/${key}`, false)
}

export async function presignBlobUrl({
  method,
  key,
  endpoint,
  bucket,
  region = 'auto',
  accessKeyId,
  secretAccessKey,
  expiresSeconds = defaultBrokerTtlSeconds,
  now = new Date(),
  forcePathStyle = true,
}) {
  const httpMethod = normalizeBrokerMethod(method)
  if (!endpoint) throw new Error('Broker is missing the R2 endpoint.')
  if (!bucket) throw new Error('Broker is missing the R2 bucket.')
  if (!accessKeyId || !secretAccessKey) throw new Error('Broker is missing R2 credentials.')

  const endpointUrl = new URL(endpoint)
  const host = forcePathStyle ? endpointUrl.host : `${bucket}.${endpointUrl.host}`
  const amzDate = toAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`

  const queryPairs = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const canonicalQuery = queryPairs
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const canonicalUri = objectPath(bucket, key, forcePathStyle)
  const canonicalHeaders = `host:${host}\n`
  const signedHeaders = 'host'
  const canonicalRequest = [
    httpMethod,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region, 's3'), stringToSign))
  const url = `${endpointUrl.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
  const expiresAt = new Date(now.getTime() + expiresSeconds * 1000).toISOString()
  return { url, method: httpMethod, key, expiresAt }
}

// Resolve the R2 signing config from Worker env. Returns null when unconfigured so
// the caller can answer a clear 503 rather than presign against nothing.
export function brokerR2ConfigFromEnv(env) {
  const accountId = stringOrNull(env?.HOPIT_R2_ACCOUNT_ID)
  const endpoint = stringOrNull(env?.HOPIT_R2_ENDPOINT)
    ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null)
  const bucket = stringOrNull(env?.HOPIT_R2_BUCKET)
  const accessKeyId = stringOrNull(env?.HOPIT_R2_ACCESS_KEY_ID)
  const secretAccessKey = stringOrNull(env?.HOPIT_R2_SECRET_ACCESS_KEY)
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: stringOrNull(env?.HOPIT_R2_REGION) ?? 'auto',
    prefix: normalizeBrokerPrefix(env?.HOPIT_BLOB_PREFIX),
    expiresSeconds: ttlSecondsFromEnv(env?.HOPIT_BLOB_BROKER_TTL_SECONDS),
  }
}

function ttlSecondsFromEnv(value) {
  if (value === undefined || value === null || value === '') return defaultBrokerTtlSeconds
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3600) return defaultBrokerTtlSeconds
  return parsed
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
