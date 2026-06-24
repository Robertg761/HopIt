'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Bell,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { HopItLogo } from './logo'
import { cn } from '@/lib/utils'
import {
  dashboardSections,
  navigateToSection,
  sectionHref,
  type DashboardSection,
} from '@/components/hopit/navigation'

type SidebarProps = {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const [activeSection, setActiveSection] = React.useState(dashboardSections[0].id)
  const [query, setQuery] = React.useState('')
  const visibleSections = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return dashboardSections

    return dashboardSections.filter((item) =>
      [item.label, item.description, ...item.keywords]
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    )
  }, [query])

  React.useEffect(() => {
    const sections = dashboardSections
      .map((item) => document.getElementById(item.id))
      .filter(Boolean) as HTMLElement[]

    if (sections.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]

        if (visible?.target.id) setActiveSection(visible.target.id)
      },
      {
        rootMargin: '-18% 0px -68% 0px',
        threshold: [0.1, 0.25, 0.5],
      },
    )

    sections.forEach((section) => observer.observe(section))

    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!open) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open])

  function handleNavigate(id: string) {
    setActiveSection(id)
    navigateToSection(id)
    onClose()
  }

  return (
    <>
      {/* Mobile backdrop */}
      <motion.button
        type="button"
        className={cn(
          'fixed inset-0 z-40 bg-ink/55 backdrop-blur-md transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-label="Close sidebar overlay"
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[284px] flex-col border-r border-white/10 bg-ink text-ink-foreground shadow-2xl transition-transform duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none',
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
        <p className="px-5 -mt-1 pb-4 text-[11px] uppercase text-ink-foreground/40">
          Code &amp; files. Together.
        </p>

        {/* Compact search */}
        <div className="px-3 pb-4">
          <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-ink-foreground/60 ring-1 ring-inset ring-white/10">
            <Search className="size-4 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              placeholder="Filter sections"
              className="w-full bg-transparent text-ink-foreground placeholder:text-ink-foreground/40 focus:outline-none"
              aria-label="Filter navigation sections"
            />
          </div>
        </div>

        {/* Primary nav */}
        <nav className="px-3 space-y-0.5">
          {visibleSections.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={activeSection === item.id}
              onNavigate={() => handleNavigate(item.id)}
            />
          ))}
        </nav>

        {/* Collaborators */}
        <div className="mt-auto px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] uppercase text-ink-foreground/40">
              Online
            </p>
            <Users className="size-3.5 text-ink-foreground/40" />
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-3">
            <p className="text-xs text-ink-foreground/70">No live teammates connected</p>
            <p className="mt-1 text-[10.5px] text-ink-foreground/40">
              Presence will appear here after a real workspace session connects.
            </p>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex items-center justify-between border-t border-white/5 px-5 py-3">
          <a
            href={sectionHref('activity')}
            onClick={(event) => {
              event.preventDefault()
              handleNavigate('activity')
            }}
            className="flex items-center gap-2 text-xs text-ink-foreground/50 hover:text-ink-foreground/80"
            aria-label="Notifications"
          >
            <Bell className="size-3.5" />
            <span>Notifications</span>
          </a>
          <a
            href={sectionHref('status')}
            onClick={(event) => {
              event.preventDefault()
              handleNavigate('status')
            }}
            className="text-ink-foreground/50 hover:text-ink-foreground/80"
            aria-label="Settings"
          >
            <Settings className="size-3.5" />
          </a>
        </div>
      </aside>
    </>
  )
}

function NavButton({
  item,
  active,
  onNavigate,
}: {
  item: DashboardSection
  active: boolean
  onNavigate: () => void
}) {
  const Icon = item.icon
  return (
    <motion.a
      href={sectionHref(item.id)}
      onClick={(event) => {
        event.preventDefault()
        onNavigate()
      }}
      aria-current={active ? 'page' : undefined}
      whileHover={{ x: 2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-hop/15 text-hop ring-1 ring-inset ring-hop/30'
          : 'text-ink-foreground/70 hover:bg-white/5 hover:text-ink-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
    </motion.a>
  )
}
