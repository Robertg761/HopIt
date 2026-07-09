'use client'

import * as React from 'react'
import { Menu, Search, Sparkles } from 'lucide-react'

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
    <header className="sticky top-0 z-30 flex h-[4.5rem] items-center gap-3 border-b border-border/80 bg-background/85 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
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
        className="hidden h-9 w-72 items-center gap-2 rounded-full border border-border bg-card/70 px-3 text-sm text-muted-foreground transition-all hover:border-foreground/25 hover:bg-card sm:flex outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Sparkles className="size-3.5 text-[var(--signal-orange)]" />
        <span className="flex-1 text-left text-xs">Jump anywhere or run a command</span>
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
