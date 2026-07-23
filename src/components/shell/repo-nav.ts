import {
  Activity,
  Code2,
  GitPullRequest,
  Radio,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type RepoTab = {
  id: string
  label: string
  /** Path segment after /codebases/[id]. Empty string = code tab at repo root. */
  segment: string
  icon: LucideIcon
  description: string
  keywords: string[]
}

/** GitHub-shaped repository tabs. Agent is HopIt-specific. */
export const repoTabs: RepoTab[] = [
  {
    id: 'code',
    label: 'Code',
    segment: '',
    icon: Code2,
    description: 'Browse and edit repository files.',
    keywords: ['files', 'tree', 'browser', 'code'],
  },
  {
    id: 'pulls',
    label: 'Pull requests',
    segment: 'pulls',
    icon: GitPullRequest,
    description: 'Change sets, reviews, threads, and merge.',
    keywords: ['review', 'pr', 'diff', 'merge', 'compare', 'history'],
  },
  {
    id: 'activity',
    label: 'Activity',
    segment: 'activity',
    icon: Activity,
    description: 'Notifications and recent events.',
    keywords: ['events', 'feed', 'notifications'],
  },
  {
    id: 'collaborators',
    label: 'Collaborators',
    segment: 'collaborators',
    icon: Users,
    description: 'People, invitations, roles, and key grants.',
    keywords: ['members', 'people', 'invite', 'access', 'keys'],
  },
  {
    id: 'settings',
    label: 'Settings',
    segment: 'settings',
    icon: Settings,
    description: 'Sync policy, privacy, and repository configuration.',
    keywords: ['config', 'policy', 'privacy'],
  },
  {
    id: 'agent',
    label: 'Agent',
    segment: 'agent',
    icon: Radio,
    description: 'Local agent health, commands, and action jobs.',
    keywords: ['status', 'daemon', 'device', 'commands', 'jobs'],
  },
]

export function repoBasePath(codebaseId: string): string {
  return `/codebases/${encodeURIComponent(codebaseId)}`
}

export function repoPath(codebaseId: string, segment = ''): string {
  const base = repoBasePath(codebaseId)
  return segment ? `${base}/${segment}` : base
}

/** Extract codebase id from a /codebases/[id]/… path. */
export function codebaseIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/codebases\/([^/]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** Preserve the current repo tab when switching repositories. */
export function repoPathPreservingTab(pathname: string, nextCodebaseId: string): string {
  const currentId = codebaseIdFromPath(pathname)
  if (!currentId) return repoPath(nextCodebaseId)

  const prefix = `/codebases/${encodeURIComponent(currentId)}`
  // Prefer raw path segment after the id (pathname may not be encoded the same way).
  const rawPrefix = `/codebases/${currentId}`
  let rest = ''
  if (pathname.startsWith(prefix)) {
    rest = pathname.slice(prefix.length).replace(/^\//, '')
  } else if (pathname.startsWith(rawPrefix)) {
    rest = pathname.slice(rawPrefix.length).replace(/^\//, '')
  }

  // Map legacy review path to the primary pulls tab.
  if (rest === 'review') rest = 'pulls'

  return repoPath(nextCodebaseId, rest)
}

export function activeRepoTabId(pathname: string): string {
  if (!pathname.startsWith('/codebases/')) return 'code'
  const parts = pathname.split('/').filter(Boolean)
  // ['codebases', id, ...rest]
  const rest = parts.slice(2)
  const head = rest[0] ?? ''

  if (!head) return 'code'
  if (head === 'pulls' || head === 'review' || head === 'compare' || head === 'history') return 'pulls'
  if (head === 'activity') return 'activity'
  if (head === 'collaborators' || head === 'members') return 'collaborators'
  if (head === 'settings') return 'settings'
  if (head === 'agent' || head === 'status') return 'agent'
  return 'code'
}

/** Global account-level nav (shown in the sidebar). */
export const globalNavItems = [
  {
    id: 'home',
    href: '/',
    label: 'Dashboard',
    description: 'Overview of your workspace and repositories.',
    keywords: ['home', 'overview', 'dashboard', 'summary'],
  },
  {
    id: 'codebases',
    href: '/codebases',
    label: 'Repositories',
    description: 'Browse and manage cloud repositories.',
    keywords: ['repos', 'repositories', 'codebases', 'projects', 'import', 'attach'],
  },
] as const
