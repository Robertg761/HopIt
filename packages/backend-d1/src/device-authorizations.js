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
// A batch authorization replaces N separate browser round trips, so the rate
// limiter above stops being the ceiling on how many projects can be connected in
// one sitting. This cap takes over that job: it bounds the work a single approval
// can trigger (one session registration and one key wrap per project) and keeps
// the approval checklist reviewable by a human.
const maxCodebasesPerAuthorization = 50

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
      // The scalar columns mirror the first requested project so a browser tab or
      // agent running pre-batch code still sees a coherent single-project request.
      const requestedCodebases = normalizeRequestedCodebases(options)
      const requestedCodebaseId = requestedCodebases[0]?.id ?? null
      const requestedCodebaseName = requestedCodebases[0]?.name ?? null
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
      // One batch, not one round trip per project: `hop add --all` blocks on this
      // call before it can even print the approval link, and a 50-project request
      // would otherwise be 50 sequential D1 calls.
      if (requestedCodebases.length > 0) {
        await this.queryBatch(requestedCodebases.map((entry, position) => ({
          sql: `insert into device_authorization_codebases (
            authorization_id, position, requested_codebase_id, requested_codebase_name, state
          ) values (?, ?, ?, ?, 'requested')`,
          params: [authorizationId, position, entry.id, entry.name],
        })))
      }
      return {
        authorizationId,
        deviceCode,
        userCode,
        expiresAt,
        intervalSeconds: 2,
        requestedCodebases,
      }
    },

    // Requested projects for an authorization, oldest schema first: rows created
    // before device_authorization_codebases existed fall back to the scalar pair
    // so an authorization already in flight during a deploy still approves.
    async deviceAuthorizationCodebases(row) {
      if (!row) return []
      const rows = await this.query(
        `select * from device_authorization_codebases
         where authorization_id = ? order by position asc`,
        [row.authorization_id],
      )
      if (rows.length > 0) {
        return rows.map((entry) => ({
          requestedId: entry.requested_codebase_id,
          requestedName: entry.requested_codebase_name ?? entry.requested_codebase_id,
          codebaseId: entry.codebase_id ?? null,
          sessionId: entry.session_id ?? null,
          wrappedSessionToken: parseJson(entry.wrapped_session_token_json, null),
          state: entry.state,
        }))
      }
      if (!row.requested_codebase_id && !row.codebase_id) return []
      return [{
        requestedId: row.requested_codebase_id ?? row.codebase_id,
        requestedName: row.requested_codebase_name ?? row.requested_codebase_id ?? row.codebase_id,
        codebaseId: row.codebase_id ?? null,
        sessionId: row.session_id ?? null,
        wrappedSessionToken: parseJson(row.wrapped_session_token_json, null),
        state: row.codebase_id ? 'approved' : 'requested',
      }]
    },

    async readDeviceAuthorizationForApproval(userCode) {
      await this.ensureSchema()
      await this.expireDeviceAuthorizations()
      const row = await this.first(
        `select * from device_authorizations where user_code = ? limit 1`,
        [normalizeUserCode(userCode)],
      )
      return summarizeForApproval(row, await this.deviceAuthorizationCodebases(row))
    },

    async approveDeviceAuthorization(options = {}) {
      await this.ensureSchema()
      const actor = requireAuthenticatedActor(options.actor, 'Sign in before approving this device.')
      const userCode = normalizeUserCode(options.userCode)
      const selections = normalizeApprovalSelections(options)
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
        return summarizeForApproval(row, await this.deviceAuthorizationCodebases(row))
      }
      if (row.status !== 'pending') throw new Error(`Device authorization is ${row.status}.`)

      // Adopting an EXISTING project when the terminal asked to create a new one
      // is the destructive case: the device starts operating on that project and
      // the import can overwrite its managed workspace. The browser gates this per
      // row, but the rule is enforced here too so it holds for any caller, not just
      // our own UI.
      for (const selection of selections) {
        if (selection.requestedCodebaseId
          && selection.requestedCodebaseId !== selection.codebaseId
          && !selection.acknowledgedExisting) {
          throw new Error(
            `Approving "${selection.codebaseId}" for requested project "${selection.requestedCodebaseId}" `
            + 'needs an explicit acknowledgement.',
          )
        }
      }

      const deviceKey = normalizeDeviceKey(parseJson(row.device_key_json, null))
      const now = new Date().toISOString()
      await this.query(
        `update device_authorizations set
          status = 'approving', user_id = ?, codebase_id = ?, updated_at = ?
         where authorization_id = ? and status = 'pending'`,
        [actor.userId, selections[0].codebaseId, now, row.authorization_id],
      )
      const claimed = await this.first(
        `select * from device_authorizations where authorization_id = ?`,
        [row.authorization_id],
      )
      if (claimed?.status !== 'approving' || claimed.user_id !== actor.userId) {
        throw new Error('This device authorization is already being approved.')
      }

      try {
        const context = deviceAuthorizationTokenContext(row.authorization_id)
        const approved = []
        for (const [index, selection] of selections.entries()) {
          // Capabilities are derived per project from the access this account
          // already holds there, so a batch can never grant more than a series of
          // single approvals would have.
          const { access } = await this.requireGraphCapability(selection.codebaseId, actor, 'read')
          const capabilities = ['read']
          if (hasCapability(access, 'write')) capabilities.push('write', 'sync', 'watch')
          if (hasCapability(access, 'admin')) capabilities.push('admin')
          await this.registerDeviceKey({
            ...deviceKey,
            codebaseId: selection.codebaseId,
            actor,
          })
          const registered = await this.registerAgentSession({
            codebaseId: selection.codebaseId,
            sessionId: deviceAuthorizationSessionId(row.authorization_id, index),
            deviceName: deviceKey.displayName,
            capabilities,
            actor,
          })
          const wrappedSessionToken = wrapSymmetricKeyForDevice({
            key: Buffer.from(registered.sessionToken, 'utf8'),
            recipientPublicKeyPem: deviceKey.encryptionPublicKey,
            context,
          })
          approved.push({
            requestedId: selection.requestedCodebaseId ?? selection.codebaseId,
            codebaseId: selection.codebaseId,
            sessionId: requireTextValue(registered.session?.sessionId, 'Registered session id'),
            wrappedSessionToken,
          })
        }

        const approvedAt = new Date().toISOString()
        await this.queryBatch(approved.map((entry, position) => ({
          sql: `insert into device_authorization_codebases (
            authorization_id, position, requested_codebase_id, requested_codebase_name,
            codebase_id, session_id, wrapped_session_token_json, state
          ) values (?, ?, ?, null, ?, ?, ?, 'approved')
          on conflict(authorization_id, requested_codebase_id) do update set
            codebase_id = excluded.codebase_id,
            session_id = excluded.session_id,
            wrapped_session_token_json = excluded.wrapped_session_token_json,
            state = 'approved'`,
          params: [
            row.authorization_id,
            position,
            entry.requestedId,
            entry.codebaseId,
            entry.sessionId,
            stringifyJson(entry.wrappedSessionToken),
          ],
        })))
        // Scalars mirror the first approved project for pre-batch agents.
        await this.query(
          `update device_authorizations set
            status = 'approved', codebase_id = ?, session_id = ?, wrapped_session_token_json = ?,
            approved_at = ?, updated_at = ?
           where authorization_id = ? and status = 'approving' and user_id = ?`,
          [
            approved[0].codebaseId,
            approved[0].sessionId,
            stringifyJson(approved[0].wrappedSessionToken),
            approvedAt,
            approvedAt,
            row.authorization_id,
            actor.userId,
          ],
        )
        const finalRow = await this.first(
          `select * from device_authorizations where authorization_id = ?`,
          [row.authorization_id],
        )
        return summarizeForApproval(finalRow, await this.deviceAuthorizationCodebases(finalRow))
      } catch (error) {
        // A batch can fail partway through, after some projects already have
        // sessions registered. Roll the authorization back to pending and clear the
        // child rows so a retry re-derives everything instead of handing the agent a
        // half-approved set. The already-registered sessions stay (they are scoped
        // and harmless); the retry re-registers them by the same deterministic id.
        const failedAt = new Date().toISOString()
        await this.query(
          `update device_authorization_codebases set
            codebase_id = null, session_id = null, wrapped_session_token_json = null, state = 'requested'
           where authorization_id = ?`,
          [row.authorization_id],
        )
        await this.query(
          `update device_authorizations set
            status = 'pending', user_id = null, codebase_id = null,
            session_id = null, wrapped_session_token_json = null, updated_at = ?
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
      const approved = (await this.deviceAuthorizationCodebases(row)).filter((entry) => entry.codebaseId)
      return {
        authorizationId: row.authorization_id,
        status: 'approved',
        // Scalar fields describe the first approved project and keep pre-batch
        // agents working unchanged; `codebases` carries the full set.
        codebaseId: row.codebase_id,
        requesterId: row.user_id,
        sessionId: row.session_id,
        wrappedSessionToken: parseJson(row.wrapped_session_token_json, null),
        codebases: approved.map((entry) => ({
          requestedCodebaseId: entry.requestedId,
          codebaseId: entry.codebaseId,
          sessionId: entry.sessionId,
          wrappedSessionToken: entry.wrappedSessionToken,
        })),
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
      // D1 has no cascading delete here, so sweep child rows whose authorization is
      // gone. Wrapped session tokens live in these rows; they must not outlive the
      // authorization they belong to.
      await this.query(
        `delete from device_authorization_codebases
         where authorization_id not in (select authorization_id from device_authorizations)`,
      )
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

function summarizeForApproval(row, requestedCodebases = []) {
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
    requestedCodebases: requestedCodebases.map((entry) => ({
      id: entry.requestedId,
      name: entry.requestedName ?? entry.requestedId,
      codebaseId: entry.codebaseId ?? null,
      state: entry.state,
    })),
    requesterId: row.user_id ?? null,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at ?? null,
  }
}

/**
 * Requested projects for a new authorization. Accepts the batch form
 * (`requestedCodebases`) or the original singular pair, so an older agent keeps
 * working against a batch-aware server. An empty list is valid and means "the
 * browser picks" -- the plain `hop setup` case.
 */
function normalizeRequestedCodebases(options) {
  const raw = Array.isArray(options.requestedCodebases) && options.requestedCodebases.length > 0
    ? options.requestedCodebases
    : [{ id: options.requestedCodebaseId, name: options.requestedCodebaseName }]
  const entries = []
  const seen = new Set()
  for (const value of raw) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : { id: value }
    const id = normalizeRequestedCodebaseId(record.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    entries.push({ id, name: stringOrNull(record.name) ?? id })
  }
  if (entries.length > maxCodebasesPerAuthorization) {
    throw new Error(`A device authorization can request at most ${maxCodebasesPerAuthorization} projects.`)
  }
  return entries
}

/**
 * Projects the browser approved. Accepts the batch form (`selections`) or the
 * original scalar `codebaseId`, so a browser tab holding pre-batch JavaScript can
 * still approve while a deploy rolls out.
 */
function normalizeApprovalSelections(options) {
  const raw = Array.isArray(options.selections) && options.selections.length > 0
    ? options.selections
    : [{
        codebaseId: options.codebaseId,
        requestedCodebaseId: options.requestedCodebaseId,
        acknowledgedExisting: options.acknowledgedExisting,
      }]
  const selections = []
  const seen = new Set()
  for (const value of raw) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : { codebaseId: value }
    const codebaseId = requireTextValue(record.codebaseId, 'Codebase id')
    if (seen.has(codebaseId)) continue
    seen.add(codebaseId)
    selections.push({
      codebaseId,
      requestedCodebaseId: normalizeRequestedCodebaseId(record.requestedCodebaseId),
      acknowledgedExisting: record.acknowledgedExisting === true,
    })
  }
  if (selections.length === 0) throw new Error('Select at least one project to approve.')
  if (selections.length > maxCodebasesPerAuthorization) {
    throw new Error(`A device authorization can approve at most ${maxCodebasesPerAuthorization} projects.`)
  }
  return selections
}

// Index 0 keeps the exact id the single-project flow has always produced, so
// existing approvals and any id already persisted downstream stay stable.
function deviceAuthorizationSessionId(authorizationId, index) {
  const base = `session_${authorizationId.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
  return index === 0 ? base : `${base}_${index + 1}`
}
