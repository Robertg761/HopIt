'use client'

import * as React from 'react'
import { Menu, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { AuthMenu } from '@/components/shell/auth-menu'
import { ThemeToggle } from '@/components/shell/theme-toggle'
import { CodebaseSwitcher } from '@/components/shell/codebase-switcher'

export function Topbar({
  onOpenPalette,
  onOpenNav,
}: {
  onOpenPalette: () => void
  onOpenNav: () => void
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        onClick={onOpenNav}
        className="text-muted-foreground lg:hidden"
      >
        <Menu />
      </Button>

      <CodebaseSwitcher />

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden h-8 w-64 items-center gap-2 rounded-lg border border-border px-2.5 text-sm text-muted-foreground/80 transition-colors hover:border-input hover:text-muted-foreground sm:flex outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left text-xs">Search or run a command…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search"
        onClick={onOpenPalette}
        className="text-muted-foreground sm:hidden"
      >
        <Search />
      </Button>

      <ThemeToggle />
      <AuthMenu />
    </header>
  )
}
