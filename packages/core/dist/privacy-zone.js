export const privacyZoneKind = {
    repoContent: 'repo-content',
    ownerPrivate: 'owner-private',
    secrets: 'secrets',
    gitInternals: 'git-internals',
    publicSnapshot: 'public-snapshot',
};
export function normalizeCloudPath(relativePath) {
    return String(relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}
export function scopeForPath(relativePath) {
    const normalized = normalizeCloudPath(relativePath);
    return normalized === '.private' ||
        normalized.startsWith('.private/') ||
        normalized === '.git' ||
        normalized.startsWith('.git/')
        ? 'owner-private'
        : 'shared';
}
export function privacyZoneForPath(relativePath) {
    const normalized = normalizeCloudPath(relativePath);
    if (normalized === '.private/env' || normalized.startsWith('.private/env/')) {
        return privacyZoneKind.secrets;
    }
    if (normalized === '.git' ||
        normalized.startsWith('.git/') ||
        normalized === '.private/git' ||
        normalized.startsWith('.private/git/')) {
        return privacyZoneKind.gitInternals;
    }
    if (scopeForPath(normalized) === 'owner-private') {
        return privacyZoneKind.ownerPrivate;
    }
    return privacyZoneKind.repoContent;
}
export function privacyZoneIdForPath(codebaseId, relativePath) {
    return `${codebaseId}:${privacyZoneForPath(relativePath)}`;
}
export function isLocalOnlySecretPath(relativePath) {
    const normalized = normalizeCloudPath(relativePath);
    return normalized === '.private/env' || normalized.startsWith('.private/env/');
}
export function hasPrivatePrivacyZone(relativePath) {
    return privacyZoneForPath(relativePath) !== privacyZoneKind.repoContent;
}
//# sourceMappingURL=privacy-zone.js.map