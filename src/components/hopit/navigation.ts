import {
  Activity,
  Code2,
  Folder,
  GitPullRequest,
  HardDrive,
  Home,
  PackageCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type DashboardSection = {
  id: string
  path: string
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
}

export const dashboardSections: DashboardSection[] = [
  {
    id: 'overview',
    path: '/overview',
    label: 'Overview',
    description: 'Workspace health, file counts, pending writes, and review state.',
    icon: Home,
    keywords: ['home', 'summary', 'stats', 'dashboard'],
  },
  {
    id: 'codebases',
    path: '/codebases',
    label: 'Codebases',
    description: 'Connected repositories, visibility, snapshots, and sync status.',
    icon: Code2,
    keywords: ['repos', 'repositories', 'projects', 'snapshots'],
  },
  {
    id: 'files',
    path: '/files',
    label: 'Files',
    description: 'Workspace files, folders, scopes, search, and import entry points.',
    icon: Folder,
    keywords: ['drive', 'folders', 'private', 'shared', 'import', 'upload'],
  },
  {
    id: 'review',
    path: '/review',
    label: 'Review',
    description: 'Code browser, changed files, review follow-ups, and merge state.',
    icon: GitPullRequest,
    keywords: ['diff', 'code', 'history', 'merge', 'comments'],
  },
  {
    id: 'members',
    path: '/members',
    label: 'Members',
    description: 'Owner claim, members, invitations, and access controls.',
    icon: Users,
    keywords: ['people', 'members', 'invite', 'permissions', 'auth'],
  },
  {
    id: 'work-items',
    path: '/work-items',
    label: 'Work items',
    description: 'Issues, discussions, releases, and project planning.',
    icon: PackageCheck,
    keywords: ['issues', 'projects', 'discussions', 'releases'],
  },
  {
    id: 'activity',
    path: '/activity',
    label: 'Activity',
    description: 'Live agent events, recent syncs, reviews, and changes.',
    icon: Activity,
    keywords: ['events', 'feed', 'notifications', 'syncs'],
  },
  {
    id: 'status',
    path: '/status',
    label: 'Agent status',
    description: 'Workspace agent health, remote pull, hydration, and commands.',
    icon: HardDrive,
    keywords: ['settings', 'agent', 'daemon', 'remote', 'commands'],
  },
]

export function sectionHref(id: string) {
  return dashboardSections.find((section) => section.id === id)?.path ?? `/${id}`
}

export function navigateToSection(id: string) {
  if (typeof window === 'undefined') return

  const href = sectionHref(id)

  if (window.location.pathname === href) {
    document.getElementById('page-main')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }

  window.location.assign(href)
}
