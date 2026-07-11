import { randomBytes, randomUUID } from 'node:crypto'
import { wrapSymmetricKeyForDevice } from '@hopit/core/crypto'
import { defineBackendMethods } from './method-support.js'
import {
  assertDevicePublicKeyDescriptor,
  hasCapability,
  hashText,
  parseJson,
  requireAuthenticatedActor,
  requireTextValue,
  stringOrNull,
  stringifyJson,
} from './helpers/index.js'

const authorizationLifetimeMs = 10 * 60 * 1000
const authorizationRateWindowMs = 15 * 60 * 1000
const authorizationRateLimit = 10
const userCodeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function attachDeviceAuthorizationMethods(Backend) {
  defineBackendMethods(Backend, {
    async createDeviceAuthorization(options = {}) {
      await this.ensureSchema()
      const deviceKey = normalizeDeviceKey(options.deviceKey)
      const requestFingerprint = stringOrNull(options.requestFingerprint)
      await this.expireDeviceAuthorizations()
      if (requestFingerprint) {
        const since = new Date(Date.now() - authorizationRateWindowMs).toISOString()
        const row = await this.first(
          `select count(*) as count from device_authorizations
           where request_fingerprint = ? and created_at >= ?`,
          [requestFingerprint, since],
        )
        if (Number(row?.count ?? 0) >= authorizationRateLimit) {
          throw new Error('Too many device authorization attempts. Wait a few minutes and try again.')
        }
      }

      const now = new Date()
      const authorizationId = `dau_${randomUUID()}`
      const deviceCode = `hdc_${randomBytes(32).toString('base64url')}`
      const userCode = await this.createUniqueDeviceUserCode()
      const expiresAt = new Date(now.getTime() + authorizationLifetimeMs).toISOString()
      const requestedCodebaseId = normalizeRequestedCodebaseId(options.requestedCodebaseId)
      const requestedCodebaseName = stringOrNull(options.requestedCodebaseName)
      await this.query(
        `insert into device_authorizations (
          authorization_id, device_code_hash, user_code, request_fingerprint,
          device_id, device_name, platform, device_key_json, status,
          requested_codebase_id, requested_codebase_name,
          created_at, expires_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          authorizationId,
          hashDeviceCode(deviceCode),
          userCode,
          requestFingerprint,
          deviceKey.deviceId,
          stringOrNull(deviceKey.displayName),
          stringOrNull(deviceKey.platform),
          stringifyJson(deviceKey),
          requestedCodebaseId,
          requestedCodebaseName,
          now.toISOString(),
          expiresAt,
          now.toISOString(),
        ],
      )
      return {
        authorizationId,
        deviceCode,
        userCode,
        expiresAt,
        intervalSeconds: 2,
      }
    },

    async readDeviceAuthorizationForApproval(userCode) {
      await this.ensureSchema()
      await this.expireDeviceAuthorizations()
      const row = await this.first(
        `select * from device_authorizations where user_code = ? limit 1`,
        [normalizeUserCode(userCode)],
      )
      return summarizeForApproval(row)
    },

    async approveDeviceAuthorization(options = {}) {
      await this.ensureSchema()
      const actor = requireAuthenticatedActor(options.actor, 'Sign in before approving this device.')
      const userCode = normalizeUserCode(options.userCode)
      const codebaseId = requireTextValue(options.codebaseId, 'Codebase id')
      await this.expireDeviceAuthorizations()
      const row = await this.first(
        `select * from device_authorizations where user_code = ? limit 1`,
        [userCode],
      )
      if (!row) throw new Error('Device authorization code was not found.')
      if (row.status === 'expired' || Date.parse(row.expires_at) <= Date.now()) {
        throw new Error('Device authorization code has expired. Run hop setup again.')
      }
      if (row.status === 'approved') {
        if (row.user_id !== actor.userId) throw new Error('This device was approved by another account.')
        return summarizeForApproval(row)
      }
      if (row.status !== 'pending') throw new Error(`Device authorization is ${row.status}.`)

      const { access } = await this.requireGraphCapability(codebaseId, actor, 'read')
      const capabilities = ['read']
      if (hasCapability(access, 'write')) capabilities.push('write', 'sync', 'watch')
      if (hasCapability(access, 'admin')) capabilities.push('admin')
      const deviceKey = normalizeDeviceKey(parseJson(row.device_key_json, null))
      const now = new Date().toISOString()
      await this.query(
        `update device_authorizations set
          status = 'approving', user_id = ?, codebase_id = ?, updated_at = ?
         where authorization_id = ? and status = 'pending'`,
        [actor.userId, codebaseId, now, row.authorization_id],
      )
      const claimed = await this.first(
        `select * from device_authorizations where authorization_id = ?`,
        [row.authorization_id],
      )
      if (claimed?.status !== 'approving' || claimed.user_id !== actor.userId) {
        throw new Error('This device authorization is already being approved.')
      }

      try {
        const sessionId = `session_${row.authorization_id.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
        await this.registerDeviceKey({
          ...deviceKey,
          codebaseId,
          actor,
        })
        const registered = await this.registerAgentSession({
          codebaseId,
          sessionId,
          deviceName: deviceKey.displayName,
          capabilities,
          actor,
        })
        const context = deviceAuthorizationTokenContext(row.authorization_id)
        const wrappedSessionToken = wrapSymmetricKeyForDevice({
          key: Buffer.from(registered.sessionToken, 'utf8'),
          recipientPublicKeyPem: deviceKey.encryptionPublicKey,
          context,
        })
        const registeredSessionId = requireTextValue(registered.session?.sessionId, 'Registered session id')
        const approvedAt = new Date().toISOString()
        await this.query(
          `update device_authorizations set
            status = 'approved', session_id = ?, wrapped_session_token_json = ?,
            approved_at = ?, updated_at = ?
           where authorization_id = ? and status = 'approving' and user_id = ?`,
          [
            registeredSessionId,
            stringifyJson(wrappedSessionToken),
            approvedAt,
            approvedAt,
            row.authorization_id,
            actor.userId,
          ],
        )
        return summarizeForApproval(await this.first(
          `select * from device_authorizations where authorization_id = ?`,
          [row.authorization_id],
        ))
      } catch (error) {
        const failedAt = new Date().toISOString()
        await this.query(
          `update device_authorizations set
            status = 'pending', user_id = null, codebase_id = null, updated_at = ?
           where authorization_id = ? and status = 'approving' and user_id = ?`,
          [failedAt, row.authorization_id, actor.userId],
        )
        throw error
      }
    },

    async pollDeviceAuthorization(deviceCode) {
      await this.ensureSchema()
      await this.expireDeviceAuthorizations()
      const row = await this.first(
        `select * from device_authorizations where device_code_hash = ? limit 1`,
        [hashDeviceCode(deviceCode)],
      )
      if (!row) return { status: 'not_found' }
      if (row.status === 'approving') {
        return {
          authorizationId: row.authorization_id,
          status: 'pending',
          expiresAt: row.expires_at,
        }
      }
      if (row.status !== 'approved') {
        return {
          authorizationId: row.authorization_id,
          status: row.status,
          expiresAt: row.expires_at,
        }
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        return {
          authorizationId: row.authorization_id,
          status: 'expired',
          expiresAt: row.expires_at,
        }
      }
      const now = new Date().toISOString()
      if (!row.consumed_at) {
        await this.query(
          `update device_authorizations set consumed_at = ?, updated_at = ? where authorization_id = ?`,
          [now, now, row.authorization_id],
        )
      }
      return {
        authorizationId: row.authorization_id,
        status: 'approved',
        codebaseId: row.codebase_id,
        requesterId: row.user_id,
        sessionId: row.session_id,
        wrappedSessionToken: parseJson(row.wrapped_session_token_json, null),
        tokenContext: deviceAuthorizationTokenContext(row.authorization_id),
        expiresAt: row.expires_at,
      }
    },

    async expireDeviceAuthorizations() {
      const now = new Date().toISOString()
      await this.query(
        `update device_authorizations set status = 'expired', updated_at = ?
         where status = 'pending' and expires_at <= ?`,
        [now, now],
      )
      const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      await this.query(`delete from device_authorizations where updated_at < ?`, [stale])
    },

    async createUniqueDeviceUserCode() {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const raw = Array.from(randomBytes(8), (byte) => userCodeAlphabet[byte % userCodeAlphabet.length]).join('')
        const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
        const existing = await this.first(
          `select authorization_id from device_authorizations where user_code = ? limit 1`,
          [code],
        )
        if (!existing) return code
      }
      throw new Error('Could not allocate a unique device authorization code.')
    },
  })
}

function normalizeDeviceKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A device public key descriptor is required.')
  }
  const deviceKey = {
    deviceId: requireTextValue(value.deviceId, 'Device id'),
    displayName: stringOrNull(value.displayName),
    platform: stringOrNull(value.platform),
    encryptionPublicKey: requireTextValue(value.encryptionPublicKey, 'Device encryption public key'),
    encryptionPublicKeyAlgorithm: requireTextValue(value.encryptionPublicKeyAlgorithm, 'Device encryption algorithm'),
    encryptionPublicKeyEncoding: requireTextValue(value.encryptionPublicKeyEncoding, 'Device encryption key encoding'),
    signingPublicKey: stringOrNull(value.signingPublicKey),
    signingPublicKeyAlgorithm: stringOrNull(value.signingPublicKeyAlgorithm),
    signingPublicKeyEncoding: stringOrNull(value.signingPublicKeyEncoding),
  }
  assertDevicePublicKeyDescriptor(deviceKey)
  return deviceKey
}

function normalizeUserCode(value) {
  const raw = requireTextValue(value, 'Device authorization code')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (raw.length !== 8) throw new Error('Device authorization code must contain 8 characters.')
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

function hashDeviceCode(value) {
  const code = requireTextValue(value, 'Device code')
  if (!code.startsWith('hdc_') || code.length < 40) throw new Error('Device code is invalid.')
  return hashText(code)
}

function normalizeRequestedCodebaseId(value) {
  const text = stringOrNull(value)
  if (!text) return null
  const normalized = text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || null
}

function deviceAuthorizationTokenContext(authorizationId) {
  return `device-authorization:${authorizationId}:session-token`
}

function summarizeForApproval(row) {
  if (!row) return null
  return {
    authorizationId: row.authorization_id,
    userCode: row.user_code,
    status: row.status,
    device: {
      id: row.device_id,
      name: row.device_name,
      platform: row.platform,
    },
    codebaseId: row.codebase_id ?? null,
    requestedCodebaseId: row.requested_codebase_id ?? null,
    requestedCodebaseName: row.requested_codebase_name ?? null,
    requesterId: row.user_id ?? null,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at ?? null,
  }
}
