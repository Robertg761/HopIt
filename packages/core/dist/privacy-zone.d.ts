export declare const privacyZoneKind: {
    readonly repoContent: "repo-content";
    readonly ownerPrivate: "owner-private";
    readonly secrets: "secrets";
    readonly gitInternals: "git-internals";
    readonly publicSnapshot: "public-snapshot";
};
export type PrivacyZoneKind = typeof privacyZoneKind[keyof typeof privacyZoneKind];
export type FileScope = 'shared' | 'owner-private';
export declare function normalizeCloudPath(relativePath: string | null | undefined): string;
export declare function scopeForPath(relativePath: string | null | undefined): FileScope;
export declare function privacyZoneForPath(relativePath: string | null | undefined): PrivacyZoneKind;
export declare function privacyZoneIdForPath(codebaseId: string, relativePath: string | null | undefined): string;
export declare function isLocalOnlySecretPath(relativePath: string | null | undefined): boolean;
export declare function hasPrivatePrivacyZone(relativePath: string | null | undefined): boolean;
//# sourceMappingURL=privacy-zone.d.ts.map