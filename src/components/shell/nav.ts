import {
  BookMarked,
  CircleDollarSign,
  House,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'

import { repoTabs } from '@/components/shell/repo-nav'

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

/** Account-level sidebar only. Repository features live under repo top tabs. */
export const navGroups: NavGroup[] = [
  {
    id: 'main',
    label: null,
    items: [
      {
        id: 'home',
        href: '/overview',
        label: 'Dashboard',
        description: 'Overview of your workspace and repositories.',
        icon: House,
        keywords: ['home', 'overview', 'dashboard', 'summary'],
      },
      {
        id: 'codebases',
        href: '/codebases',
        label: 'Repositories',
        description: 'Browse and manage cloud repositories.',
        icon: BookMarked,
        keywords: ['repos', 'repositories', 'codebases', 'projects', 'import', 'attach'],
      },
      {
        id: 'pricing',
        href: '/pricing',
        label: 'Plans',
        description: 'Compare storage plans and manage billing.',
        icon: CircleDollarSign,
        keywords: ['plans', 'pricing', 'billing', 'upgrade', 'storage'],
      },
    ],
  },
]

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items)

export const serviceAdminNavItem: NavItem = {
  id: 'admin',
  href: '/admin',
  label: 'Operations',
  description: 'Monitor tenants, quotas, billing, sync health, and service controls.',
  icon: SlidersHorizontal,
  keywords: ['admin', 'operations', 'tenants', 'quota', 'billing', 'health', 'monitor'],
}

export function accountNavItems(serviceAdmin = false) {
  return serviceAdmin ? [...navItems, serviceAdminNavItem] : navItems
}

export function activeNavId(pathname: string): string {
  if (pathname === '/overview') return 'home'
  if (pathname.startsWith('/codebases')) return 'codebases'
  if (pathname.startsWith('/pricing')) return 'pricing'
  if (pathname.startsWith('/admin')) return 'admin'
  // Legacy routes still highlight Repositories while redirecting.
  if (
    pathname.startsWith('/files') ||
    pathname.startsWith('/review') ||
    pathname.startsWith('/work-items') ||
    pathname.startsWith('/activity') ||
    pathname.startsWith('/members') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/status')
  ) {
    return 'codebases'
  }
  return 'home'
}

/** Command-palette entries for the active repository, if any. */
export function repoPaletteItems(codebaseId: string): Array<{
  id: string
  href: string
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
}> {
  return repoTabs.map((tab) => ({
    id: `repo-${tab.id}`,
    href: tab.segment
      ? `/codebases/${encodeURIComponent(codebaseId)}/${tab.segment}`
      : `/codebases/${encodeURIComponent(codebaseId)}`,
    label: tab.label,
    description: tab.description,
    icon: tab.icon,
    keywords: tab.keywords,
  }))
}
