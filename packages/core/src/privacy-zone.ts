export const privacyZoneKind = {
  repoContent: 'repo-content',
  ownerPrivate: 'owner-private',
  secrets: 'secrets',
  gitInternals: 'git-internals',
  publicSnapshot: 'public-snapshot',
} as const

export type PrivacyZoneKind = typeof privacyZoneKind[keyof typeof privacyZoneKind]
export type FileScope = 'shared' | 'owner-private'

export function normalizeCloudPath(relativePath: string | null | undefined): string {
  return String(relativePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

export function scopeForPath(relativePath: string | null | undefined): FileScope {
  const normalized = normalizeCloudPath(relativePath)
  return normalized === '.private' ||
    normalized.startsWith('.private/') ||
    normalized === '.git' ||
    normalized.startsWith('.git/')
    ? 'owner-private'
    : 'shared'
}

export function privacyZoneForPath(relativePath: string | null | undefined): PrivacyZoneKind {
  const normalized = normalizeCloudPath(relativePath)
  if (normalized === '.private/env' || normalized.startsWith('.private/env/')) {
    return privacyZoneKind.secrets
  }
  if (
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === '.private/git' ||
    normalized.startsWith('.private/git/')
  ) {
    return privacyZoneKind.gitInternals
  }
  if (scopeForPath(normalized) === 'owner-private') {
    return privacyZoneKind.ownerPrivate
  }
  return privacyZoneKind.repoContent
}

export function privacyZoneIdForPath(codebaseId: string, relativePath: string | null | undefined): string {
  return `${codebaseId}:${privacyZoneForPath(relativePath)}`
}

export function isLocalOnlySecretPath(relativePath: string | null | undefined): boolean {
  const normalized = normalizeCloudPath(relativePath)
  return normalized === '.private/env' || normalized.startsWith('.private/env/')
}

export function hasPrivatePrivacyZone(relativePath: string | null | undefined): boolean {
  return privacyZoneForPath(relativePath) !== privacyZoneKind.repoContent
}
