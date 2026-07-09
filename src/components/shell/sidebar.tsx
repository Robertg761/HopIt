'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'
import { HopItLogo } from '@/components/brand/logo'
import { activeNavId, navGroups } from '@/components/shell/nav'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { ArrowUpRight } from 'lucide-react'
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
      <div className="flex h-[4.5rem] items-center border-b border-white/10 px-5">
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-xl text-[var(--sidebar-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)]/60"
        >
          <HopItLogo size={31} />
        </Link>
        <span className="ml-auto font-mono text-[0.58rem] font-semibold uppercase tracking-[0.2em] text-[var(--sidebar-muted)]">
          Relay 01
        </span>
      </div>

      <div className="px-5 pb-4 pt-5">
        <p className="font-display text-[1.65rem] leading-[1.02] tracking-[-0.03em] text-white">
          Code that keeps<br />up with you.
        </p>
      </div>

      <nav className="scroll-thin flex-1 space-y-5 overflow-y-auto px-3 pb-5">
        {navGroups.map((group, groupIndex) => (
          <div key={group.id}>
            {group.label ? (
              <p className="mb-1.5 flex items-center gap-2 px-2.5 font-mono text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-[var(--sidebar-muted)]">
                <span>{String(groupIndex + 1).padStart(2, '0')}</span>
                <span className="h-px flex-1 bg-white/10" />
                <span>{group.label}</span>
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
                        'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.82rem] font-semibold outline-none transition-all focus-visible:ring-2 focus-visible:ring-[var(--signal)]/60',
                        isActive
                          ? 'bg-[var(--signal)] text-[#17352e] shadow-[0_8px_28px_rgba(201,244,92,0.13)]'
                          : 'text-[var(--sidebar-muted)] hover:bg-white/[0.07] hover:text-white',
                      )}
                    >
                      <item.icon className="size-[1.05rem] shrink-0" strokeWidth={1.8} />
                      <span className="flex-1">{item.label}</span>
                      {isActive ? <ArrowUpRight className="size-3.5" /> : null}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <div className="rounded-2xl bg-black/15 p-3.5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[0.58rem] font-semibold uppercase tracking-[0.15em] text-[var(--sidebar-muted)]">
            Agent signal
            <span className="relay-dash h-px flex-1 text-white/20" />
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-white">
          <StatusDot tone={stateTone[status.state] ?? 'neutral'} pulse={status.state === 'online'} />
          <span className="truncate" title={status.healthLabel}>
            {status.healthLabel || 'Agent status unknown'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
