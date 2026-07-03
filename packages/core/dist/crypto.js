// @ts-nocheck
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes, randomUUID, } from 'node:crypto';
import { hasPrivatePrivacyZone, isLocalOnlySecretPath, privacyZoneForPath, privacyZoneIdForPath, privacyZoneKind, } from './privacy-zone.js';
export { hasPrivatePrivacyZone, isLocalOnlySecretPath, privacyZoneForPath, privacyZoneIdForPath, privacyZoneKind, } from './privacy-zone.js';
export const clientEncryption = {
    version: 1,
    state: 'client-encrypted',
    algorithm: 'aes-256-gcm',
    aadVersion: 'hopit-file-v1',
    keyBytes: 32,
    nonceBytes: 12,
};
export const clientEncryptionScopes = {
    secrets: 'secrets',
    ownerPrivate: 'owner-private',
    all: 'all',
    off: 'off',
};
export const deviceKeyAlgorithms = {
    encryption: 'x25519',
    signing: 'ed25519',
    wrap: 'x25519-aes-256-gcm',
    recoveryWrap: 'pbkdf2-sha256-aes-256-gcm',
};
export const symmetricKeyBytes = 32;
export function clientEncryptionScopeFromOptions(options = {}, env = process.env) {
    const raw = options['client-encryption-scope'] ?? env.HOPIT_CLIENT_ENCRYPTION_SCOPE ?? clientEncryptionScopes.secrets;
    if (raw === 'private')
        return clientEncryptionScopes.ownerPrivate;
    if (raw === clientEncryptionScopes.ownerPrivate)
        return clientEncryptionScopes.ownerPrivate;
    if (raw === clientEncryptionScopes.all)
        return clientEncryptionScopes.all;
    if (raw === clientEncryptionScopes.off || raw === '0' || raw === 'false')
        return clientEncryptionScopes.off;
    return clientEncryptionScopes.secrets;
}
export function rawClientEncryptionKey(options = {}, env = process.env) {
    return options['client-encryption-key'] ?? env.HOPIT_CLIENT_ENCRYPTION_KEY ?? env.HOPIT_SECRET_SYNC_KEY ?? null;
}
export function clientEncryptionConfigFromOptions(options = {}, env = process.env) {
    const raw = rawClientEncryptionKey(options, env);
    if (!raw)
        return null;
    const key = decodeClientEncryptionKey(raw);
    return {
        state: clientEncryption.state,
        algorithm: clientEncryption.algorithm,
        version: clientEncryption.version,
        aadVersion: clientEncryption.aadVersion,
        key,
        keyId: options['client-encryption-key-id'] ?? env.HOPIT_CLIENT_ENCRYPTION_KEY_ID ?? hashBuffer(key).slice(0, 16),
        scope: clientEncryptionScopeFromOptions(options, env),
    };
}
export function decodeClientEncryptionKey(raw) {
    const value = String(raw).trim();
    const candidates = [];
    if (value.startsWith('base64url:')) {
        candidates.push(Buffer.from(base64UrlToBase64(value.slice('base64url:'.length)), 'base64'));
    }
    else if (value.startsWith('base64:')) {
        candidates.push(Buffer.from(value.slice('base64:'.length), 'base64'));
    }
    else if (value.startsWith('hex:')) {
        candidates.push(Buffer.from(value.slice('hex:'.length), 'hex'));
    }
    else {
        if (/^[0-9a-f]{64}$/i.test(value))
            candidates.push(Buffer.from(value, 'hex'));
        candidates.push(Buffer.from(base64UrlToBase64(value), 'base64'));
    }
    const key = candidates.find((candidate) => candidate.byteLength === clientEncryption.keyBytes);
    if (!key) {
        throw new Error('HOPIT_CLIENT_ENCRYPTION_KEY must decode to 32 bytes. Generate one with: openssl rand -base64 32');
    }
    return key;
}
export function shouldEncryptWithConfig(relativePath, config) {
    if (!config || config.scope === clientEncryptionScopes.off)
        return false;
    if (config.scope === clientEncryptionScopes.all)
        return true;
    if (config.scope === clientEncryptionScopes.ownerPrivate)
        return hasPrivatePrivacyZone(relativePath);
    return isLocalOnlySecretPath(relativePath);
}
export function encryptClientPayload({ buffer, codebaseId, relativePath, plaintextHash, config }) {
    const nonce = randomBytes(clientEncryption.nonceBytes);
    const aad = clientEncryptionAad({ codebaseId, relativePath, plaintextHash });
    const cipher = createCipheriv(clientEncryption.algorithm, config.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const ciphertextHash = hashBuffer(ciphertext);
    const zone = privacyZoneForPath(relativePath);
    return {
        buffer: ciphertext,
        hash: ciphertextHash,
        metadata: {
            version: clientEncryption.version,
            state: clientEncryption.state,
            algorithm: clientEncryption.algorithm,
            aadVersion: clientEncryption.aadVersion,
            keyId: config.keyId,
            zone,
            zoneId: privacyZoneIdForPath(codebaseId, relativePath),
            nonce: nonce.toString('base64url'),
            authTag: authTag.toString('base64url'),
            plaintextHash,
            plaintextSize: buffer.byteLength,
            ciphertextHash,
            ciphertextSize: ciphertext.byteLength,
        },
    };
}
export function decryptClientPayload({ buffer, codebaseId, relativePath, encryption, config }) {
    if (!encryption || encryption.state !== clientEncryption.state)
        return buffer;
    if (!config) {
        throw new Error(`client_encryption_key_missing: cannot decrypt ${relativePath}`);
    }
    if (encryption.algorithm !== clientEncryption.algorithm) {
        throw new Error(`unsupported_client_encryption_algorithm: ${encryption.algorithm}`);
    }
    if (encryption.version !== undefined && encryption.version !== clientEncryption.version) {
        throw new Error(`unsupported_client_encryption_version: ${encryption.version}`);
    }
    if (encryption.keyId && encryption.keyId !== config.keyId) {
        throw new Error(`client_encryption_key_mismatch: ${relativePath} requires key ${encryption.keyId}`);
    }
    if (encryption.zone && encryption.zone !== privacyZoneForPath(relativePath)) {
        throw new Error(`client_encryption_zone_mismatch: ${relativePath} requires zone ${encryption.zone}`);
    }
    if (encryption.ciphertextHash && hashBuffer(buffer) !== encryption.ciphertextHash) {
        throw new Error(`client_encryption_ciphertext_hash_mismatch: ${relativePath}`);
    }
    if (Number.isInteger(encryption.ciphertextSize) && buffer.byteLength !== encryption.ciphertextSize) {
        throw new Error(`client_encryption_ciphertext_size_mismatch: ${relativePath}`);
    }
    const nonce = Buffer.from(base64UrlToBase64(encryption.nonce ?? ''), 'base64');
    const authTag = Buffer.from(base64UrlToBase64(encryption.authTag ?? ''), 'base64');
    const aad = clientEncryptionAad({ codebaseId, relativePath, plaintextHash: encryption.plaintextHash });
    const decipher = createDecipheriv(clientEncryption.algorithm, config.key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(buffer), decipher.final()]);
}
export function prepareBlobPayload({ codebaseId, relativePath, plaintextHash, buffer, encrypt, encryptionConfig }) {
    if (!encrypt) {
        return {
            buffer,
            blobHash: plaintextHash,
            clientEncryption: null,
        };
    }
    if (!encryptionConfig) {
        throw new Error(`client_encryption_key_missing: cannot encrypt ${relativePath}`);
    }
    const encrypted = encryptClientPayload({
        buffer,
        codebaseId,
        relativePath,
        plaintextHash,
        config: encryptionConfig,
    });
    return {
        buffer: encrypted.buffer,
        blobHash: encrypted.hash,
        clientEncryption: encrypted.metadata,
    };
}
export function unwrapBlobPayload(buffer, file, context = {}, encryptionConfig = null) {
    const expectedBlobHash = file.blobHash ?? file.hash;
    const actualBlobHash = hashBuffer(buffer);
    if (expectedBlobHash && actualBlobHash !== expectedBlobHash) {
        throw new Error(`object_blob_hash_mismatch: expected ${expectedBlobHash}, got ${actualBlobHash}`);
    }
    if (Number.isInteger(file.blobSize) && buffer.byteLength !== file.blobSize) {
        throw new Error(`object_blob_size_mismatch: expected ${file.blobSize}, got ${buffer.byteLength}`);
    }
    if (file.clientEncryption?.state === clientEncryption.state) {
        return decryptClientPayload({
            buffer,
            codebaseId: context.codebaseId ?? 'hopit',
            relativePath: context.relativePath ?? '',
            encryption: file.clientEncryption,
            config: encryptionConfig,
        });
    }
    return buffer;
}
export function normalizeClientEncryptionMetadata(value) {
    if (!value || typeof value !== 'object')
        return null;
    if (value.state !== clientEncryption.state)
        return null;
    return {
        version: Number.isInteger(value.version) ? value.version : undefined,
        state: clientEncryption.state,
        algorithm: value.algorithm === clientEncryption.algorithm ? clientEncryption.algorithm : String(value.algorithm ?? ''),
        aadVersion: typeof value.aadVersion === 'string' ? value.aadVersion : undefined,
        keyId: typeof value.keyId === 'string' ? value.keyId : null,
        zone: typeof value.zone === 'string' ? value.zone : undefined,
        zoneId: typeof value.zoneId === 'string' ? value.zoneId : undefined,
        nonce: typeof value.nonce === 'string' ? value.nonce : '',
        authTag: typeof value.authTag === 'string' ? value.authTag : '',
        plaintextHash: typeof value.plaintextHash === 'string' ? value.plaintextHash : null,
        plaintextSize: Number.isInteger(value.plaintextSize) ? value.plaintextSize : null,
        ciphertextHash: typeof value.ciphertextHash === 'string' ? value.ciphertextHash : undefined,
        ciphertextSize: Number.isInteger(value.ciphertextSize) ? value.ciphertextSize : undefined,
    };
}
export function validateClientEncryptionMetadata(metadata, label = 'clientEncryption') {
    const errors = [];
    if (!metadata || metadata.state !== clientEncryption.state)
        return errors;
    if (metadata.version !== undefined && metadata.version !== clientEncryption.version)
        errors.push(`${label}.version is invalid.`);
    if (metadata.algorithm !== clientEncryption.algorithm)
        errors.push(`${label}.algorithm is invalid.`);
    if (metadata.aadVersion !== undefined && metadata.aadVersion !== clientEncryption.aadVersion)
        errors.push(`${label}.aadVersion is invalid.`);
    if (!isNonEmptyString(metadata.keyId))
        errors.push(`${label}.keyId is required.`);
    if (!isNonEmptyString(metadata.nonce))
        errors.push(`${label}.nonce is required.`);
    if (!isNonEmptyString(metadata.authTag))
        errors.push(`${label}.authTag is required.`);
    if (!isNonEmptyString(metadata.plaintextHash))
        errors.push(`${label}.plaintextHash is required.`);
    if (!Number.isInteger(metadata.plaintextSize))
        errors.push(`${label}.plaintextSize is required.`);
    if (metadata.zone !== undefined && !Object.values(privacyZoneKind).includes(metadata.zone))
        errors.push(`${label}.zone is invalid.`);
    if (metadata.zoneId !== undefined && !isNonEmptyString(metadata.zoneId))
        errors.push(`${label}.zoneId is invalid.`);
    if (metadata.ciphertextHash !== undefined && !isNonEmptyString(metadata.ciphertextHash))
        errors.push(`${label}.ciphertextHash is invalid.`);
    if (metadata.ciphertextSize !== undefined && !Number.isInteger(metadata.ciphertextSize))
        errors.push(`${label}.ciphertextSize is invalid.`);
    return errors;
}
export function createDeviceKeyMaterial({ deviceId = `dev_${randomUUID()}`, deviceName = null, platform = process.platform } = {}) {
    const encryption = generateKeyPairSync(deviceKeyAlgorithms.encryption);
    const signing = generateKeyPairSync(deviceKeyAlgorithms.signing);
    const userVaultKey = randomBytes(symmetricKeyBytes);
    const userVaultKeyId = `uvk_${randomUUID()}`;
    const now = new Date().toISOString();
    const publicKeyPem = encryption.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = encryption.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const signingPublicKeyPem = signing.publicKey.export({ type: 'spki', format: 'pem' });
    const signingPrivateKeyPem = signing.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const selfWrappedVaultKey = wrapSymmetricKeyForDevice({
        key: userVaultKey,
        recipientPublicKeyPem: publicKeyPem,
        context: `user-vault:${userVaultKeyId}:device:${deviceId}`,
    });
    return {
        schemaVersion: 1,
        deviceId,
        deviceName,
        platform,
        createdAt: now,
        updatedAt: now,
        encryption: {
            algorithm: deviceKeyAlgorithms.encryption,
            publicKeyEncoding: 'spki-pem',
            privateKeyEncoding: 'pkcs8-pem',
            publicKeyPem,
            privateKeyPem,
        },
        signing: {
            algorithm: deviceKeyAlgorithms.signing,
            publicKeyEncoding: 'spki-pem',
            privateKeyEncoding: 'pkcs8-pem',
            publicKeyPem: signingPublicKeyPem,
            privateKeyPem: signingPrivateKeyPem,
        },
        userVault: {
            keyId: userVaultKeyId,
            currentVersion: 1,
            wrappedKey: selfWrappedVaultKey,
            recoveryConfigured: false,
        },
    };
}
export function publicDeviceKeyDescriptor(keyring) {
    return {
        deviceId: keyring.deviceId,
        displayName: keyring.deviceName ?? null,
        platform: keyring.platform ?? null,
        encryptionPublicKey: keyring.encryption.publicKeyPem,
        encryptionPublicKeyAlgorithm: keyring.encryption.algorithm,
        encryptionPublicKeyEncoding: keyring.encryption.publicKeyEncoding,
        signingPublicKey: keyring.signing.publicKeyPem,
        signingPublicKeyAlgorithm: keyring.signing.algorithm,
        signingPublicKeyEncoding: keyring.signing.publicKeyEncoding,
    };
}
export function unwrapUserVaultKey(keyring) {
    return unwrapSymmetricKeyFromDevice({
        wrappedKey: keyring.userVault.wrappedKey,
        recipientPrivateKeyPem: keyring.encryption.privateKeyPem,
        context: `user-vault:${keyring.userVault.keyId}:device:${keyring.deviceId}`,
    });
}
export function wrapSymmetricKeyForDevice({ key, recipientPublicKeyPem, context }) {
    const ephemeral = generateKeyPairSync(deviceKeyAlgorithms.encryption);
    const sharedSecret = diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: createPublicKey(recipientPublicKeyPem),
    });
    const salt = randomBytes(16);
    const nonce = randomBytes(clientEncryption.nonceBytes);
    const wrappingKey = deriveWrapKey(sharedSecret, salt, context);
    const cipher = createCipheriv(clientEncryption.algorithm, wrappingKey, nonce);
    const aad = Buffer.from(`hopit:key-wrap:v1:${context}`, 'utf8');
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(key)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        version: 1,
        algorithm: deviceKeyAlgorithms.wrap,
        keyBytes: Buffer.from(key).byteLength,
        ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }),
        ephemeralPublicKeyAlgorithm: deviceKeyAlgorithms.encryption,
        salt: salt.toString('base64url'),
        nonce: nonce.toString('base64url'),
        authTag: authTag.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        context,
    };
}
export function unwrapSymmetricKeyFromDevice({ wrappedKey, recipientPrivateKeyPem, context }) {
    if (!wrappedKey || wrappedKey.algorithm !== deviceKeyAlgorithms.wrap) {
        throw new Error(`unsupported_wrapped_key_algorithm: ${wrappedKey?.algorithm ?? '(missing)'}`);
    }
    if (wrappedKey.context !== context) {
        throw new Error(`wrapped_key_context_mismatch: expected ${context}`);
    }
    const sharedSecret = diffieHellman({
        privateKey: createPrivateKey(recipientPrivateKeyPem),
        publicKey: createPublicKey(wrappedKey.ephemeralPublicKey),
    });
    const salt = Buffer.from(base64UrlToBase64(wrappedKey.salt), 'base64');
    const nonce = Buffer.from(base64UrlToBase64(wrappedKey.nonce), 'base64');
    const authTag = Buffer.from(base64UrlToBase64(wrappedKey.authTag), 'base64');
    const ciphertext = Buffer.from(base64UrlToBase64(wrappedKey.ciphertext), 'base64');
    const wrappingKey = deriveWrapKey(sharedSecret, salt, context);
    const decipher = createDecipheriv(clientEncryption.algorithm, wrappingKey, nonce);
    const aad = Buffer.from(`hopit:key-wrap:v1:${context}`, 'utf8');
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (Number.isInteger(wrappedKey.keyBytes) && key.byteLength !== wrappedKey.keyBytes) {
        throw new Error(`wrapped_key_size_mismatch: expected ${wrappedKey.keyBytes}, got ${key.byteLength}`);
    }
    return key;
}
export function encryptRecoveryPayload({ key, passphrase, context }) {
    if (!passphrase)
        throw new Error('Recovery export requires a passphrase.');
    const salt = randomBytes(16);
    const nonce = randomBytes(clientEncryption.nonceBytes);
    const iterations = 310_000;
    const wrappingKey = pbkdf2Sync(String(passphrase), salt, iterations, symmetricKeyBytes, 'sha256');
    const cipher = createCipheriv(clientEncryption.algorithm, wrappingKey, nonce);
    const aad = Buffer.from(`hopit:recovery:v1:${context}`, 'utf8');
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(key)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        version: 1,
        algorithm: deviceKeyAlgorithms.recoveryWrap,
        kdf: 'pbkdf2-sha256',
        iterations,
        salt: salt.toString('base64url'),
        nonce: nonce.toString('base64url'),
        authTag: authTag.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        context,
    };
}
export function decryptRecoveryPayload({ recovery, passphrase, context }) {
    if (!recovery || recovery.algorithm !== deviceKeyAlgorithms.recoveryWrap) {
        throw new Error(`unsupported_recovery_algorithm: ${recovery?.algorithm ?? '(missing)'}`);
    }
    if (recovery.context !== context)
        throw new Error(`recovery_context_mismatch: expected ${context}`);
    const salt = Buffer.from(base64UrlToBase64(recovery.salt), 'base64');
    const nonce = Buffer.from(base64UrlToBase64(recovery.nonce), 'base64');
    const authTag = Buffer.from(base64UrlToBase64(recovery.authTag), 'base64');
    const ciphertext = Buffer.from(base64UrlToBase64(recovery.ciphertext), 'base64');
    const iterations = Number.isInteger(recovery.iterations) ? recovery.iterations : 310_000;
    const wrappingKey = pbkdf2Sync(String(passphrase), salt, iterations, symmetricKeyBytes, 'sha256');
    const decipher = createDecipheriv(clientEncryption.algorithm, wrappingKey, nonce);
    const aad = Buffer.from(`hopit:recovery:v1:${context}`, 'utf8');
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function deriveWrapKey(sharedSecret, salt, context) {
    return Buffer.from(hkdfSync('sha256', sharedSecret, salt, `hopit:key-wrap:v1:${context}`, symmetricKeyBytes));
}
export function hashBuffer(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
export function base64UrlToBase64(value) {
    const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    return `${base64}${padding}`;
}
function clientEncryptionAad({ codebaseId, relativePath, plaintextHash }) {
    return Buffer.from(`hopit:v1:file:${codebaseId}:${relativePath}:${plaintextHash ?? ''}`, 'utf8');
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
//# sourceMappingURL=crypto.js.map