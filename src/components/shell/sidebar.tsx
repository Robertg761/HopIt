'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'
import { HopItLogo } from '@/components/brand/logo'
import { activeNavId, navGroups } from '@/components/shell/nav'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'

const stateTone: Record<string, StatusDotTone> = {
  online: 'hop',
  syncing: 'info',
  offline: 'neutral',
  blocked: 'danger',
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const active = activeNavId(pathname ?? '/')
  const { status } = useWorkspace()

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <HopItLogo />
        </Link>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-2 scroll-thin">
        {navGroups.map((group) => (
          <div key={group.id}>
            {group.label ? (
              <p className="mb-1 px-2 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = item.id === active
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                        isActive
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      )}
                    >
                      <item.icon className={cn('size-4 shrink-0', isActive && 'text-hop')} />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusDot tone={stateTone[status.state] ?? 'neutral'} pulse={status.state === 'online'} />
          <span className="truncate" title={status.healthLabel}>
            {status.healthLabel || 'Agent status unknown'}
          </span>
        </div>
      </div>
    </div>
  )
}
