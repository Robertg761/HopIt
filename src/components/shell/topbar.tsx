'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import { HopItLogo } from '@/components/brand/logo'
import { AuthMenu } from '@/components/shell/auth-menu'
import { ThemeToggle } from '@/components/shell/theme-toggle'
import { CodebaseSwitcher } from '@/components/shell/codebase-switcher'
import { activeNavId, navItems } from '@/components/shell/nav'
import { useWorkspace } from '@/components/workspace/workspace-provider'

const stateTone: Record<string, StatusDotTone> = {
  online: 'hop',
  syncing: 'info',
  offline: 'neutral',
  blocked: 'danger',
}

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname() ?? '/'
  const active = activeNavId(pathname)
  const { status } = useWorkspace()

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HopItLogo size={22} />
        </Link>

        <nav aria-label="Account" className="hidden items-center gap-0.5 sm:flex">
          {navItems.map((item) => {
            const isActive = item.id === active
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="mx-1 h-5 w-px shrink-0 bg-border max-sm:hidden" aria-hidden />

        <CodebaseSwitcher />

        <div className="flex-1" />

        <span
          className="hidden items-center gap-1.5 text-xs text-muted-foreground md:inline-flex"
          title={status.healthLabel || 'Agent status'}
        >
          <StatusDot tone={stateTone[status.state] ?? 'neutral'} pulse={status.state === 'online'} />
          <span className="max-w-36 truncate">{status.healthLabel || 'Agent offline'}</span>
        </span>

        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-8 w-52 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted lg:flex outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left text-xs">Search or jump to…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search"
          onClick={onOpenPalette}
          className="text-muted-foreground lg:hidden"
        >
          <Search />
        </Button>

        <ThemeToggle />
        <AuthMenu />
      </div>

      {/* Compact account links on small screens */}
      <nav
        aria-label="Account mobile"
        className="flex items-center gap-1 overflow-x-auto border-t border-border px-4 py-1.5 sm:hidden"
      >
        {navItems.map((item) => {
          const isActive = item.id === active
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'rounded-md px-2.5 py-1 text-sm font-medium',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
