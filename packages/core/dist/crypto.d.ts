export { hasPrivatePrivacyZone, isLocalOnlySecretPath, privacyZoneForPath, privacyZoneIdForPath, privacyZoneKind, } from './privacy-zone.js';
export declare const clientEncryption: {
    version: number;
    state: string;
    algorithm: string;
    aadVersion: string;
    keyBytes: number;
    nonceBytes: number;
};
export declare const clientEncryptionScopes: {
    secrets: string;
    ownerPrivate: string;
    all: string;
    off: string;
};
export declare const deviceKeyAlgorithms: {
    encryption: string;
    signing: string;
    wrap: string;
    recoveryWrap: string;
};
export declare const symmetricKeyBytes = 32;
export declare function clientEncryptionScopeFromOptions(options?: {}, env?: NodeJS.ProcessEnv): string;
export declare function rawClientEncryptionKey(options?: {}, env?: NodeJS.ProcessEnv): any;
export declare function clientEncryptionConfigFromOptions(options?: {}, env?: NodeJS.ProcessEnv): {
    state: string;
    algorithm: string;
    version: number;
    aadVersion: string;
    key: never;
    keyId: any;
    scope: string;
} | null;
export declare function decodeClientEncryptionKey(raw: any): never;
export declare function shouldEncryptWithConfig(relativePath: any, config: any): boolean;
export declare function encryptClientPayload({ buffer, codebaseId, relativePath, plaintextHash, config }: {
    buffer: any;
    codebaseId: any;
    relativePath: any;
    plaintextHash: any;
    config: any;
}): {
    buffer: Buffer<ArrayBuffer>;
    hash: string;
    metadata: {
        version: number;
        state: string;
        algorithm: string;
        aadVersion: string;
        keyId: any;
        zone: import("./privacy-zone.js").PrivacyZoneKind;
        zoneId: string;
        nonce: string;
        authTag: any;
        plaintextHash: any;
        plaintextSize: any;
        ciphertextHash: string;
        ciphertextSize: number;
    };
};
export declare function decryptClientPayload({ buffer, codebaseId, relativePath, encryption, config }: {
    buffer: any;
    codebaseId: any;
    relativePath: any;
    encryption: any;
    config: any;
}): any;
export declare function prepareBlobPayload({ codebaseId, relativePath, plaintextHash, buffer, encrypt, encryptionConfig }: {
    codebaseId: any;
    relativePath: any;
    plaintextHash: any;
    buffer: any;
    encrypt: any;
    encryptionConfig: any;
}): {
    buffer: any;
    blobHash: any;
    clientEncryption: null;
} | {
    buffer: Buffer<ArrayBuffer>;
    blobHash: string;
    clientEncryption: {
        version: number;
        state: string;
        algorithm: string;
        aadVersion: string;
        keyId: any;
        zone: import("./privacy-zone.js").PrivacyZoneKind;
        zoneId: string;
        nonce: string;
        authTag: any;
        plaintextHash: any;
        plaintextSize: any;
        ciphertextHash: string;
        ciphertextSize: number;
    };
};
export declare function unwrapBlobPayload(buffer: any, file: any, context?: {}, encryptionConfig?: null): any;
export declare function normalizeClientEncryptionMetadata(value: any): {
    version: any;
    state: string;
    algorithm: string;
    aadVersion: any;
    keyId: any;
    zone: any;
    zoneId: any;
    nonce: any;
    authTag: any;
    plaintextHash: any;
    plaintextSize: any;
    ciphertextHash: any;
    ciphertextSize: any;
} | null;
export declare function validateClientEncryptionMetadata(metadata: any, label?: string): never[];
export declare function createDeviceKeyMaterial({ deviceId, deviceName, platform }?: {
    deviceId?: string | undefined;
    deviceName?: null | undefined;
    platform?: NodeJS.Platform | undefined;
}): {
    schemaVersion: number;
    deviceId: string;
    deviceName: null;
    platform: NodeJS.Platform;
    createdAt: string;
    updatedAt: string;
    encryption: {
        algorithm: string;
        publicKeyEncoding: string;
        privateKeyEncoding: string;
        publicKeyPem: any;
        privateKeyPem: any;
    };
    signing: {
        algorithm: string;
        publicKeyEncoding: string;
        privateKeyEncoding: string;
        publicKeyPem: any;
        privateKeyPem: any;
    };
    userVault: {
        keyId: string;
        currentVersion: number;
        wrappedKey: {
            version: number;
            algorithm: string;
            keyBytes: number;
            ephemeralPublicKey: any;
            ephemeralPublicKeyAlgorithm: string;
            salt: string;
            nonce: string;
            authTag: any;
            ciphertext: string;
            context: any;
        };
        recoveryConfigured: boolean;
    };
};
export declare function publicDeviceKeyDescriptor(keyring: any): {
    deviceId: any;
    displayName: any;
    platform: any;
    encryptionPublicKey: any;
    encryptionPublicKeyAlgorithm: any;
    encryptionPublicKeyEncoding: any;
    signingPublicKey: any;
    signingPublicKeyAlgorithm: any;
    signingPublicKeyEncoding: any;
};
export declare function unwrapUserVaultKey(keyring: any): Buffer<ArrayBuffer>;
export declare function wrapSymmetricKeyForDevice({ key, recipientPublicKeyPem, context }: {
    key: any;
    recipientPublicKeyPem: any;
    context: any;
}): {
    version: number;
    algorithm: string;
    keyBytes: number;
    ephemeralPublicKey: any;
    ephemeralPublicKeyAlgorithm: string;
    salt: string;
    nonce: string;
    authTag: any;
    ciphertext: string;
    context: any;
};
export declare function unwrapSymmetricKeyFromDevice({ wrappedKey, recipientPrivateKeyPem, context }: {
    wrappedKey: any;
    recipientPrivateKeyPem: any;
    context: any;
}): Buffer<ArrayBuffer>;
export declare function encryptRecoveryPayload({ key, passphrase, context }: {
    key: any;
    passphrase: any;
    context: any;
}): {
    version: number;
    algorithm: string;
    kdf: string;
    iterations: number;
    salt: string;
    nonce: string;
    authTag: any;
    ciphertext: string;
    context: any;
};
export declare function decryptRecoveryPayload({ recovery, passphrase, context }: {
    recovery: any;
    passphrase: any;
    context: any;
}): Buffer<ArrayBuffer>;
export declare function hashBuffer(buffer: any): string;
export declare function base64UrlToBase64(value: any): string;
//# sourceMappingURL=crypto.d.ts.map