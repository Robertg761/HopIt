'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Bell,
  ChevronRight,
  Clock,
  Code2,
  Folder,
  Home,
  Search,
  Settings,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import { HopItLogo } from './logo'
import { collaborators } from './data'
import { cn } from '@/lib/utils'

type NavItem = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
  active?: boolean
}

const navItems: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home, active: true },
  { id: 'repos', label: 'Repositories', icon: Code2, badge: '6' },
  { id: 'files', label: 'Files', icon: Folder, badge: '184' },
  { id: 'activity', label: 'Activity', icon: Clock, badge: '12' },
]

type SidebarProps = {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col bg-ink text-ink-foreground transition-transform duration-300 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <HopItLogo size={34} />
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-foreground/60 hover:bg-white/10 hover:text-ink-foreground lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Tagline */}
        <p className="px-5 -mt-1 pb-4 text-[11px] uppercase tracking-[0.18em] text-ink-foreground/40">
          Code &amp; files. Together.
        </p>

        {/* Compact search */}
        <div className="px-3 pb-4">
          <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-ink-foreground/60 ring-1 ring-inset ring-white/10">
            <Search className="size-4 shrink-0" />
            <input
              type="search"
              placeholder="Jump to repo, file…"
              className="w-full bg-transparent text-ink-foreground placeholder:text-ink-foreground/40 focus:outline-none"
              aria-label="Search repositories and files"
            />
            <kbd className="hidden shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-ink-foreground/50 sm:inline">
              ⌘K
            </kbd>
          </div>
        </div>

        {/* Primary nav */}
        <nav className="px-3 space-y-0.5">
          {navItems.map((item) => (
            <NavButton key={item.id} item={item} />
          ))}
        </nav>

        {/* Collaborators */}
        <div className="mt-auto px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink-foreground/40">
              Online · {collaborators.length}
            </p>
            <Users className="size-3.5 text-ink-foreground/40" />
          </div>
          <div className="space-y-2">
            {collaborators.slice(0, 4).map((c) => (
              <div key={c.id} className="flex items-center gap-2.5">
                <div className="relative">
                  <div
                    className="flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                    style={{ backgroundColor: c.color }}
                  >
                    {c.name
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </div>
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-ink',
                      c.status === 'active' && 'bg-hop live-pulse',
                      c.status === 'viewing' && 'bg-amber-400',
                      c.status === 'idle' && 'bg-muted-foreground/50',
                    )}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-ink-foreground/90">
                    {c.name}
                  </p>
                  <p className="truncate text-[10.5px] text-ink-foreground/40">
                    {c.location}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <button className="mt-4 flex w-full items-center justify-between rounded-lg bg-hop/10 px-3 py-2 text-xs font-medium text-hop ring-1 ring-inset ring-hop/30 transition hover:bg-hop/20">
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-3.5" />
              Invite teammates
            </span>
            <ChevronRight className="size-3.5" />
          </button>
        </div>

        {/* Bottom bar */}
        <div className="flex items-center justify-between border-t border-white/5 px-5 py-3">
          <button
            className="flex items-center gap-2 text-xs text-ink-foreground/50 hover:text-ink-foreground/80"
            aria-label="Notifications"
          >
            <Bell className="size-3.5" />
            <span>3 new</span>
          </button>
          <button
            className="text-ink-foreground/50 hover:text-ink-foreground/80"
            aria-label="Settings"
          >
            <Settings className="size-3.5" />
          </button>
        </div>
      </aside>
    </>
  )
}

function NavButton({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <motion.button
      whileHover={{ x: 2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        item.active
          ? 'bg-hop/15 text-hop ring-1 ring-inset ring-hop/30'
          : 'text-ink-foreground/70 hover:bg-white/5 hover:text-ink-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
      {item.badge && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            item.active
              ? 'bg-hop/20 text-hop'
              : 'bg-white/10 text-ink-foreground/50',
          )}
        >
          {item.badge}
        </span>
      )}
    </motion.button>
  )
}
