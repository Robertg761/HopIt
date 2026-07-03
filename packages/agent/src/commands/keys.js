// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { clientEncryptionScopes, createDeviceKeyMaterial, encryptRecoveryPayload, publicDeviceKeyDescriptor, rawClientEncryptionKey, unwrapUserVaultKey } from '@hopit/core/crypto'
import { agentSessionTokenFromOptions, readJson, sessionCapabilitiesFromOptions, supportsAgentSessions, supportsKeyRegistration, writeSecureJson } from '../io.js'
import { hashContent } from '../journal.js'
import { readAgentState } from '../status-state.js'
import { agentStateRootFromOptions } from '../workspace-index.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

export async function runSessionCommand(action, options) {
  const allowedActions = new Set(['status', 'register', 'list', 'touch', 'revoke'])
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown session action: ${action}`)
  }

  if (action === 'status') {
    const state = await readAgentState(options)
    const sessionId = options['session-id'] ?? state.status.sessionId ?? null
    const deviceName = options['device-name'] ?? state.cloud.graph?.session?.deviceName ?? os.hostname() ?? null
    console.log(JSON.stringify({
      ok: true,
      action,
      codebaseId: state.status.codebaseId ?? options['codebase-id'] ?? null,
      session: {
        id: sessionId,
        deviceName,
        cloudSessionId: state.status.sessionId,
      },
      credentials: {
        sessionTokenConfigured: Boolean(agentSessionTokenFromOptions(options)),
      },
      cloud: {
        service: state.status.cloud.service,
        path: state.status.cloud.path,
        exists: state.status.cloud.exists,
      },
    }, null, 2))
    return
  }

  const cloudService = createCloudGraphService(options)
  if (!supportsAgentSessions(cloudService)) {
    throw new Error(`Session ${action} requires a cloud backend with scoped session support. Configure Cloudflare D1.`)
  }

  if (action === 'register') {
    const result = await cloudService.registerAgentSession({
      sessionId: options['session-id'],
      deviceName: options['device-name'] ?? os.hostname() ?? 'local-device',
      capabilities: sessionCapabilitiesFromOptions(options),
      expiresAt: options['expires-at'],
    })
    console.log(JSON.stringify({
      ok: true,
      action,
      ...result,
      note: 'Store sessionToken as HOPIT_AGENT_SESSION_TOKEN on this device. It is only returned once.',
    }, null, 2))
    return
  }

  if (action === 'list') {
    const result = await cloudService.listAgentSessions({ status: options.status })
    console.log(JSON.stringify({
      ok: true,
      action,
      codebaseId: cloudService.codebaseId,
      sessions: result,
    }, null, 2))
    return
  }

  const sessionId = options['session-id']
  if (!sessionId) {
    throw new Error(`Session ${action} requires --session-id.`)
  }

  if (action === 'touch') {
    const result = await cloudService.touchAgentSession({ sessionId })
    console.log(JSON.stringify({
      ok: true,
      action,
      session: result,
    }, null, 2))
    return
  }

  if (action === 'revoke') {
    const result = await cloudService.revokeAgentSession({ sessionId })
    console.log(JSON.stringify({
      ok: true,
      action,
      session: result,
    }, null, 2))
  }
}

export async function runKeysCommand(action, options) {
  const normalizedAction = action === 'init' ? 'init-device' : action === 'recovery' ? 'export-recovery' : action
  const allowedActions = new Set(['status', 'init-device', 'export-recovery'])
  if (!allowedActions.has(normalizedAction)) {
    throw new Error(`Unknown keys action: ${action}`)
  }

  if (normalizedAction === 'status') {
    const keyring = await readLocalDeviceKeyring(options)
    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      keyring: await summarizeLocalDeviceKeyring(options, keyring),
    }, null, 2))
    return
  }

  if (normalizedAction === 'init-device') {
    const initialized = await initializeLocalDeviceKeyring(options)
    let cloudRegistration = null
    let keyring = initialized.keyring

    if (!options['skip-cloud-registration']) {
      cloudRegistration = await registerLocalDeviceKeyringWithCloud(options, keyring)
      if (cloudRegistration?.registered) {
        keyring = {
          ...keyring,
          updatedAt: new Date().toISOString(),
          cloud: {
            ...(keyring.cloud ?? {}),
            registeredAt: cloudRegistration.registeredAt,
            deviceKey: cloudRegistration.deviceKey,
            userKeyring: cloudRegistration.userKeyring,
            userVaultWrap: cloudRegistration.userVaultWrap,
          },
        }
        await writeLocalDeviceKeyring(options, keyring)
      }
    }

    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      created: initialized.created,
      keyring: await summarizeLocalDeviceKeyring(options, keyring),
      cloudRegistration: summarizeKeyCloudRegistration(cloudRegistration),
    }, null, 2))
    return
  }

  if (normalizedAction === 'export-recovery') {
    const keyring = await requireLocalDeviceKeyring(options)
    const output = options.output
    if (!output) throw new Error('keys export-recovery requires --output.')
    if (!options.force && existsSync(output)) {
      throw new Error(`Recovery export already exists at ${output}. Use --force to overwrite.`)
    }

    const passphrase = options['recovery-passphrase'] ?? process.env.HOPIT_RECOVERY_PASSPHRASE
    const userVaultKey = unwrapUserVaultKey(keyring)
    const now = new Date().toISOString()
    const recovery = {
      schemaVersion: 1,
      kind: 'hopit-recovery-key',
      codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
      deviceId: keyring.deviceId,
      userVaultKeyId: keyring.userVault.keyId,
      currentVersion: keyring.userVault.currentVersion,
      createdAt: now,
      recovery: encryptRecoveryPayload({
        key: userVaultKey,
        passphrase,
        context: recoveryContextForKeyring(keyring),
      }),
    }
    await writeSecureJson(output, recovery)

    const updatedKeyring = {
      ...keyring,
      updatedAt: now,
      userVault: {
        ...keyring.userVault,
        recoveryConfigured: true,
        recoveryExportedAt: now,
      },
    }
    await writeLocalDeviceKeyring(options, updatedKeyring)

    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      output: path.resolve(output),
      keyring: await summarizeLocalDeviceKeyring(options, updatedKeyring),
      recovery: {
        kind: recovery.kind,
        userVaultKeyId: recovery.userVaultKeyId,
        currentVersion: recovery.currentVersion,
        createdAt: recovery.createdAt,
        encrypted: true,
      },
    }, null, 2))
  }
}

export function summarizeKeyCloudRegistration(registration) {
  if (!registration) return null
  if (!registration.registered) return registration
  return {
    registered: true,
    registeredAt: registration.registeredAt,
    deviceKey: {
      deviceId: registration.deviceKey?.deviceId ?? null,
      status: registration.deviceKey?.status ?? null,
      userId: registration.deviceKey?.userId ?? null,
    },
    userKeyring: {
      userId: registration.userKeyring?.userId ?? null,
      vaultKeyId: registration.userKeyring?.vaultKeyId ?? null,
      currentVersion: registration.userKeyring?.currentVersion ?? null,
      status: registration.userKeyring?.status ?? null,
      recoveryConfigured: Boolean(registration.userKeyring?.recoveryConfigured),
    },
    userVaultWrap: {
      wrapId: registration.userVaultWrap?.wrapId ?? null,
      wrappedKeyId: registration.userVaultWrap?.wrappedKeyId ?? null,
      recipientType: registration.userVaultWrap?.recipientType ?? null,
      recipientId: registration.userVaultWrap?.recipientId ?? null,
      status: registration.userVaultWrap?.status ?? null,
    },
  }
}

export async function applyLocalDeviceKeyring(options) {
  const keyring = await readLocalDeviceKeyring(options)
  if (!keyring) return options

  const next = {
    ...options,
    _localDeviceKeyring: keyring,
  }
  const provided = options._provided ?? new Set()

  if (!provided.has('device-id') && !process.env.HOPIT_DEVICE_ID && keyring.deviceId) {
    next['device-id'] = keyring.deviceId
  }
  if (!provided.has('device-name') && !process.env.HOPIT_DEVICE_NAME && keyring.deviceName) {
    next['device-name'] = keyring.deviceName
  }
  if (!provided.has('session-id') && !process.env.HOPIT_SESSION_ID && keyring.device?.sessionId) {
    next['session-id'] = keyring.device.sessionId
  }
  if (!provided.has('session-token') && !process.env.HOPIT_AGENT_SESSION_TOKEN && keyring.credentials?.agentSessionToken) {
    next['session-token'] = keyring.credentials.agentSessionToken
  }
  if (!rawClientEncryptionKey(options)) {
    const userVaultKey = unwrapUserVaultKey(keyring)
    next['client-encryption-key'] = `base64:${userVaultKey.toString('base64')}`
    next['client-encryption-key-id'] = keyring.userVault.keyId
  }
  if (!provided.has('client-encryption-scope') && !process.env.HOPIT_CLIENT_ENCRYPTION_SCOPE) {
    next['client-encryption-scope'] = keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets
  }

  return next
}

export async function initializeLocalDeviceKeyring(options) {
  const existing = await readLocalDeviceKeyring(options)
  if (existing && !options.force) {
    const next = mergeExistingLocalDeviceKeyring(existing, options)
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      await writeLocalDeviceKeyring(options, next)
    }
    return { created: false, keyring: next }
  }

  const keyring = buildLocalDeviceKeyringDocument(createDeviceKeyMaterial({
    deviceId: options['device-id'] ?? `dev_${randomUUID()}`,
    deviceName: options['device-name'] ?? os.hostname() ?? 'local-device',
    platform: `${process.platform}-${process.arch}`,
  }), options)
  await writeLocalDeviceKeyring(options, keyring)
  return { created: true, keyring }
}

export function buildLocalDeviceKeyringDocument(material, options) {
  const now = material.createdAt ?? new Date().toISOString()
  const sessionId = options['session-id'] ?? process.env.HOPIT_SESSION_ID ?? undefined
  const sessionToken = agentSessionTokenFromOptions(options) ?? undefined
  const clientEncryptionScope =
    options['client-encryption-scope'] ?? process.env.HOPIT_CLIENT_ENCRYPTION_SCOPE ?? clientEncryptionScopes.secrets

  const document = {
    ...material,
    kind: 'hopit-local-device-keyring',
    profile: options.profile,
    codebaseId: codebaseIdFromOptions(options),
    updatedAt: material.updatedAt ?? now,
    device: {
      deviceId: material.deviceId,
      deviceName: material.deviceName,
    },
    credentials: {},
    clientEncryption: {
      source: 'user-vault',
      keyId: material.userVault.keyId,
      scope: clientEncryptionScope,
    },
  }
  if (sessionId) document.device.sessionId = sessionId
  if (sessionToken) document.credentials.agentSessionToken = sessionToken
  return document
}

export function mergeExistingLocalDeviceKeyring(keyring, options) {
  const now = new Date().toISOString()
  const next = {
    ...keyring,
    kind: keyring.kind ?? 'hopit-local-device-keyring',
    profile: keyring.profile ?? options.profile,
    codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
    updatedAt: now,
    device: {
      ...(keyring.device ?? {}),
      deviceId: keyring.device?.deviceId ?? keyring.deviceId,
      deviceName: options['device-name'] ?? keyring.device?.deviceName ?? keyring.deviceName,
    },
    credentials: {
      ...(keyring.credentials ?? {}),
    },
    clientEncryption: {
      source: 'user-vault',
      keyId: keyring.userVault.keyId,
      scope: keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets,
      ...(keyring.clientEncryption ?? {}),
    },
  }
  if (options['session-id']) next.device.sessionId = options['session-id']
  const sessionToken = options._provided?.has('session-token') || process.env.HOPIT_AGENT_SESSION_TOKEN
    ? agentSessionTokenFromOptions(options)
    : null
  if (sessionToken) next.credentials.agentSessionToken = sessionToken
  return next
}

export async function registerLocalDeviceKeyringWithCloud(options, keyring) {
  const cloudOptions = {
    ...options,
  }
  if (!agentSessionTokenFromOptions(cloudOptions) && keyring.credentials?.agentSessionToken) {
    cloudOptions['session-token'] = keyring.credentials.agentSessionToken
  }
  const cloudService = createCloudGraphService(cloudOptions)
  if (!supportsKeyRegistration(cloudService)) {
    return { registered: false, reason: 'cloud_key_registration_not_configured' }
  }

  const registeredAt = new Date().toISOString()
  const deviceKey = await cloudService.registerDeviceKey(publicDeviceKeyDescriptor(keyring))
  const userKeyring = await cloudService.ensureUserKeyring({
    vaultKeyId: keyring.userVault.keyId,
    currentVersion: keyring.userVault.currentVersion,
    recoveryConfigured: Boolean(keyring.userVault.recoveryConfigured),
  })
  const userVaultWrap = await cloudService.createWrappedKey({
    wrapId: stableWrapId({
      codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
      wrappedKeyId: keyring.userVault.keyId,
      keyVersion: keyring.userVault.currentVersion,
      recipientType: 'device',
      recipientId: keyring.deviceId,
    }),
    wrappedKeyId: keyring.userVault.keyId,
    wrappedKeyType: 'user-vault',
    keyVersion: keyring.userVault.currentVersion,
    recipientType: 'device',
    recipientId: keyring.deviceId,
    wrappingPublicKeyId: keyring.deviceId,
    algorithm: keyring.userVault.wrappedKey.algorithm,
    ciphertext: JSON.stringify(keyring.userVault.wrappedKey),
    createdByDeviceId: keyring.deviceId,
  })

  return {
    registered: true,
    registeredAt,
    deviceKey,
    userKeyring,
    userVaultWrap,
  }
}

export async function readLocalDeviceKeyring(options) {
  const keyringPath = localDeviceKeyringPath(options)
  try {
    return await readJson(keyringPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function requireLocalDeviceKeyring(options) {
  const keyring = await readLocalDeviceKeyring(options)
  if (!keyring) throw new Error(`No local HopIt device keyring found at ${localDeviceKeyringPath(options)}. Run: hop keys init-device`)
  return keyring
}

export async function writeLocalDeviceKeyring(options, keyring) {
  await writeSecureJson(localDeviceKeyringPath(options), keyring)
}

export function localDeviceKeyringPath(options) {
  const override = options['device-keys'] ?? options.keyring ?? process.env.HOPIT_DEVICE_KEYS_PATH
  if (override) return path.resolve(override)
  return path.join(agentStateRootFromOptions(options), 'keys', `${codebaseIdFromOptions(options)}.device.json`)
}

export async function summarizeLocalDeviceKeyring(options, keyring) {
  const keyringPath = localDeviceKeyringPath(options)
  const mode = await secureFileMode(keyringPath)
  if (!keyring) {
    return {
      path: path.resolve(keyringPath),
      exists: false,
      mode,
      deviceConfigured: false,
      clientEncryptionConfigured: false,
      sessionTokenConfigured: false,
    }
  }

  return {
    path: path.resolve(keyringPath),
    exists: true,
    mode,
    schemaVersion: keyring.schemaVersion ?? null,
    kind: keyring.kind ?? null,
    profile: keyring.profile ?? null,
    codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
    deviceId: keyring.deviceId ?? null,
    deviceName: keyring.deviceName ?? null,
    platform: keyring.platform ?? null,
    encryption: {
      algorithm: keyring.encryption?.algorithm ?? null,
      publicKeyEncoding: keyring.encryption?.publicKeyEncoding ?? null,
      publicKeyFingerprint: keyring.encryption?.publicKeyPem ? fingerprintText(keyring.encryption.publicKeyPem) : null,
    },
    signing: {
      algorithm: keyring.signing?.algorithm ?? null,
      publicKeyEncoding: keyring.signing?.publicKeyEncoding ?? null,
      publicKeyFingerprint: keyring.signing?.publicKeyPem ? fingerprintText(keyring.signing.publicKeyPem) : null,
    },
    userVault: {
      keyId: keyring.userVault?.keyId ?? null,
      currentVersion: keyring.userVault?.currentVersion ?? null,
      recoveryConfigured: Boolean(keyring.userVault?.recoveryConfigured),
    },
    device: {
      sessionId: keyring.device?.sessionId ?? null,
      sessionTokenConfigured: Boolean(keyring.credentials?.agentSessionToken),
    },
    clientEncryption: {
      source: keyring.clientEncryption?.source ?? 'user-vault',
      keyId: keyring.clientEncryption?.keyId ?? keyring.userVault?.keyId ?? null,
      scope: keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets,
      configured: Boolean(keyring.userVault?.wrappedKey && keyring.encryption?.privateKeyPem),
    },
    cloud: keyring.cloud ? {
      registeredAt: keyring.cloud.registeredAt ?? null,
      deviceKeyStatus: keyring.cloud.deviceKey?.status ?? null,
      userKeyringStatus: keyring.cloud.userKeyring?.status ?? null,
      userVaultWrapStatus: keyring.cloud.userVaultWrap?.status ?? null,
    } : null,
  }
}

export async function secureFileMode(filePath) {
  try {
    const stats = await fs.stat(filePath)
    return `0${(stats.mode & 0o777).toString(8)}`
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function codebaseIdFromOptions(options) {
  return options['codebase-id'] ?? process.env.HOPIT_CODEBASE_ID ?? 'hopit'
}

export function stableWrapId({ codebaseId, wrappedKeyId, keyVersion, recipientType, recipientId }) {
  const hash = hashContent(`${codebaseId}:${wrappedKeyId}:${keyVersion}:${recipientType}:${recipientId}`).slice(0, 40)
  return `wrap_${hash}`
}

export function recoveryContextForKeyring(keyring) {
  return `user-vault:${keyring.userVault.keyId}:device:${keyring.deviceId}`
}

export function fingerprintText(value) {
  return createHash('sha256').update(String(value)).digest('base64url').slice(0, 22)
}
