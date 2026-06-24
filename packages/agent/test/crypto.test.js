import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clientEncryption,
  clientEncryptionConfigFromOptions,
  clientEncryptionScopes,
  createDeviceKeyMaterial,
  decryptRecoveryPayload,
  decryptClientPayload,
  encryptRecoveryPayload,
  encryptClientPayload,
  hashBuffer,
  prepareBlobPayload,
  privacyZoneForPath,
  shouldEncryptWithConfig,
  symmetricKeyBytes,
  unwrapSymmetricKeyFromDevice,
  unwrapBlobPayload,
  unwrapUserVaultKey,
  validateClientEncryptionMetadata,
  wrapSymmetricKeyForDevice,
} from '../src/crypto.js'

const testKey = `base64:${Buffer.alloc(32, 7).toString('base64')}`

test('privacy zone classification separates repo, private, secrets, and git internals', () => {
  assert.equal(privacyZoneForPath('src/index.ts'), 'repo-content')
  assert.equal(privacyZoneForPath('.private/notes.txt'), 'owner-private')
  assert.equal(privacyZoneForPath('.private/env/repo-root/.env.local'), 'secrets')
  assert.equal(privacyZoneForPath('.git/config'), 'git-internals')
})

test('client encryption config accepts local-only base64 keys and scope policy', () => {
  const config = clientEncryptionConfigFromOptions({
    'client-encryption-key': testKey,
    'client-encryption-key-id': 'test-key',
    'client-encryption-scope': clientEncryptionScopes.ownerPrivate,
  }, {})

  assert.equal(config.keyId, 'test-key')
  assert.equal(config.key.byteLength, 32)
  assert.equal(config.scope, clientEncryptionScopes.ownerPrivate)
  assert.equal(shouldEncryptWithConfig('.private/notes.txt', config), true)
  assert.equal(shouldEncryptWithConfig('.git/config', config), true)
  assert.equal(shouldEncryptWithConfig('src/index.ts', config), false)
})

test('client encryption envelope round-trips bytes and binds path with AAD', () => {
  const config = clientEncryptionConfigFromOptions({
    'client-encryption-key': testKey,
    'client-encryption-key-id': 'test-key',
  }, {})
  const plaintext = Buffer.from('SECRET=encrypted\n')
  const plaintextHash = hashBuffer(plaintext)
  const encrypted = encryptClientPayload({
    buffer: plaintext,
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/.env.local',
    plaintextHash,
    config,
  })

  assert.notDeepEqual(encrypted.buffer, plaintext)
  assert.equal(encrypted.metadata.version, clientEncryption.version)
  assert.equal(encrypted.metadata.state, clientEncryption.state)
  assert.equal(encrypted.metadata.algorithm, clientEncryption.algorithm)
  assert.equal(encrypted.metadata.zone, 'secrets')
  assert.equal(encrypted.metadata.zoneId, 'hopit:secrets')
  assert.equal(encrypted.metadata.plaintextHash, plaintextHash)
  assert.equal(encrypted.metadata.plaintextSize, plaintext.byteLength)
  assert.equal(encrypted.metadata.ciphertextHash, hashBuffer(encrypted.buffer))
  assert.equal(encrypted.metadata.ciphertextSize, encrypted.buffer.byteLength)
  assert.deepEqual(validateClientEncryptionMetadata(encrypted.metadata), [])

  const decrypted = decryptClientPayload({
    buffer: encrypted.buffer,
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/.env.local',
    encryption: encrypted.metadata,
    config,
  })
  assert.deepEqual(decrypted, plaintext)

  assert.throws(() => decryptClientPayload({
    buffer: encrypted.buffer,
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/renamed.env.local',
    encryption: encrypted.metadata,
    config,
  }), /client_encryption_zone_mismatch|Unsupported state or unable to authenticate data/)
})

test('object blob wrapper validates ciphertext hash before decrypting', () => {
  const config = clientEncryptionConfigFromOptions({
    'client-encryption-key': testKey,
    'client-encryption-key-id': 'test-key',
  }, {})
  const plaintext = Buffer.from('TOKEN=top-secret\n')
  const prepared = prepareBlobPayload({
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/.env.local',
    plaintextHash: hashBuffer(plaintext),
    buffer: plaintext,
    encrypt: true,
    encryptionConfig: config,
  })

  const file = {
    hash: hashBuffer(plaintext),
    size: plaintext.byteLength,
    blobHash: prepared.blobHash,
    blobSize: prepared.buffer.byteLength,
    clientEncryption: prepared.clientEncryption,
  }
  assert.deepEqual(
    unwrapBlobPayload(prepared.buffer, file, {
      codebaseId: 'hopit',
      relativePath: '.private/env/repo-root/.env.local',
    }, config),
    plaintext,
  )

  const tampered = Buffer.from(prepared.buffer)
  tampered[0] ^= 1
  assert.throws(() => unwrapBlobPayload(tampered, file, {
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/.env.local',
  }, config), /object_blob_hash_mismatch|client_encryption_ciphertext_hash_mismatch/)
})

test('legacy client encryption metadata without version remains decryptable', () => {
  const config = clientEncryptionConfigFromOptions({
    'client-encryption-key': testKey,
    'client-encryption-key-id': 'test-key',
  }, {})
  const plaintext = Buffer.from('LEGACY=1\n')
  const encrypted = encryptClientPayload({
    buffer: plaintext,
    codebaseId: 'hopit',
    relativePath: '.private/env/repo-root/.env.local',
    plaintextHash: hashBuffer(plaintext),
    config,
  })
  const legacyMetadata = {
    state: encrypted.metadata.state,
    algorithm: encrypted.metadata.algorithm,
    keyId: encrypted.metadata.keyId,
    nonce: encrypted.metadata.nonce,
    authTag: encrypted.metadata.authTag,
    plaintextHash: encrypted.metadata.plaintextHash,
    plaintextSize: encrypted.metadata.plaintextSize,
  }

  assert.deepEqual(
    decryptClientPayload({
      buffer: encrypted.buffer,
      codebaseId: 'hopit',
      relativePath: '.private/env/repo-root/.env.local',
      encryption: legacyMetadata,
      config,
    }),
    plaintext,
  )
})

test('device key material stores the user vault key only as a self-wrapped payload', () => {
  const keyring = createDeviceKeyMaterial({
    deviceId: 'dev_test_device',
    deviceName: 'Test Device',
    platform: 'test',
  })

  assert.equal(keyring.deviceId, 'dev_test_device')
  assert.equal(keyring.encryption.algorithm, 'x25519')
  assert.equal(keyring.signing.algorithm, 'ed25519')
  assert.equal(keyring.userVault.wrappedKey.algorithm, 'x25519-aes-256-gcm')
  assert.equal(Object.hasOwn(keyring.userVault, 'key'), false)

  const unwrapped = unwrapUserVaultKey(keyring)
  assert.equal(unwrapped.byteLength, symmetricKeyBytes)
})

test('device wrapped symmetric keys round-trip and bind context', () => {
  const recipient = createDeviceKeyMaterial({ deviceId: 'dev_recipient' })
  const key = Buffer.alloc(symmetricKeyBytes, 13)
  const context = 'user-vault:uvk_test:device:dev_recipient'
  const wrappedKey = wrapSymmetricKeyForDevice({
    key,
    recipientPublicKeyPem: recipient.encryption.publicKeyPem,
    context,
  })

  assert.notEqual(wrappedKey.ciphertext, key.toString('base64url'))
  assert.deepEqual(unwrapSymmetricKeyFromDevice({
    wrappedKey,
    recipientPrivateKeyPem: recipient.encryption.privateKeyPem,
    context,
  }), key)
  assert.throws(() => unwrapSymmetricKeyFromDevice({
    wrappedKey,
    recipientPrivateKeyPem: recipient.encryption.privateKeyPem,
    context: 'user-vault:uvk_test:device:wrong',
  }), /wrapped_key_context_mismatch/)
})

test('recovery payload encrypts user vault keys with a passphrase', () => {
  const key = Buffer.alloc(symmetricKeyBytes, 19)
  const context = 'user-vault:uvk_recovery:device:dev_test'
  const recovery = encryptRecoveryPayload({
    key,
    passphrase: 'correct horse battery staple',
    context,
  })

  assert.equal(recovery.algorithm, 'pbkdf2-sha256-aes-256-gcm')
  assert.notEqual(recovery.ciphertext, key.toString('base64url'))
  assert.deepEqual(decryptRecoveryPayload({
    recovery,
    passphrase: 'correct horse battery staple',
    context,
  }), key)
  assert.throws(() => decryptRecoveryPayload({
    recovery,
    passphrase: 'wrong passphrase',
    context,
  }), /Unsupported state or unable to authenticate data/)
})
