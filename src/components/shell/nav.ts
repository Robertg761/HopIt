import {
  Activity,
  Boxes,
  CircleDot,
  FolderTree,
  GitPullRequestArrow,
  House,
  Radio,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  id: string
  href: string
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
}

export type NavGroup = {
  id: string
  label: string | null
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    id: 'workspace',
    label: null,
    items: [
      {
        id: 'home',
        href: '/',
        label: 'Home',
        description: 'Workspace health, sync state, and what needs attention.',
        icon: House,
        keywords: ['home', 'overview', 'dashboard', 'summary'],
      },
      {
        id: 'activity',
        href: '/activity',
        label: 'Activity',
        description: 'Recent syncs, reviews, merges, and device events.',
        icon: Activity,
        keywords: ['events', 'feed', 'audit', 'log', 'history'],
      },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    items: [
      {
        id: 'codebases',
        href: '/codebases',
        label: 'Codebases',
        description: 'Cloud codebases, attach state, and workspace roots.',
        icon: Boxes,
        keywords: ['repos', 'repositories', 'projects', 'import', 'attach'],
      },
      {
        id: 'files',
        href: '/files',
        label: 'Files',
        description: 'Browse, edit, hydrate, and pin workspace files.',
        icon: FolderTree,
        keywords: ['drive', 'folders', 'browser', 'hydrate', 'pin', 'editor'],
      },
      {
        id: 'review',
        href: '/review',
        label: 'Review',
        description: 'Active change set, threads, decisions, and merge.',
        icon: GitPullRequestArrow,
        keywords: ['diff', 'merge', 'change set', 'threads', 'compare', 'history'],
      },
    ],
  },
  {
    id: 'collaborate',
    label: 'Collaborate',
    items: [
      {
        id: 'work-items',
        href: '/work-items',
        label: 'Work items',
        description: 'Issues, discussions, projects, and releases.',
        icon: CircleDot,
        keywords: ['issues', 'discussions', 'projects', 'releases', 'kanban'],
      },
      {
        id: 'members',
        href: '/members',
        label: 'Members',
        description: 'People, invitations, roles, and key grants.',
        icon: Users,
        keywords: ['people', 'invite', 'roles', 'access', 'keys'],
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'agent',
        href: '/status',
        label: 'Agent',
        description: 'Local agent health, commands, and action jobs.',
        icon: Radio,
        keywords: ['status', 'daemon', 'device', 'commands', 'jobs', 'ci'],
      },
      {
        id: 'settings',
        href: '/settings',
        label: 'Settings',
        description: 'Sync policy, privacy, and workspace configuration.',
        icon: Settings,
        keywords: ['settings', 'config', 'policy', 'privacy'],
      },
    ],
  },
]

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items)

export function activeNavId(pathname: string): string {
  if (pathname === '/' || pathname === '/overview') return 'home'
  if (pathname.startsWith('/codebases/') ) {
    if (pathname.includes('/work-items')) return 'work-items'
    if (pathname.includes('/review') || pathname.includes('/compare') || pathname.includes('/history')) return 'review'
    return 'codebases'
  }
  const match = navItems.find((item) => item.href !== '/' && pathname.startsWith(item.href))
  return match?.id ?? 'home'
}
