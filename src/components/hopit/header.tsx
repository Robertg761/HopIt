'use client'

import * as React from 'react'
import {
  Bell,
  ChevronDown,
  Code2,
  Menu,
  Moon,
  Plus,
  Search,
  Sun,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme } from 'next-themes'
import { AuthMenu } from '@/components/hopit/auth-menu'

type HeaderProps = {
  onOpenSidebar: () => void
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const { theme, setTheme } = useTheme()
  const activeTheme = theme ?? 'light'

  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-4 md:px-6">
        {/* Mobile menu */}
        <button
          onClick={onOpenSidebar}
          className="rounded-md p-2 hover:bg-muted lg:hidden"
          aria-label="Open sidebar"
        >
          <Menu className="size-5" />
        </button>

        {/* Breadcrumb / context */}
        <div className="hidden items-center gap-2 md:flex">
          <span className="text-sm font-medium text-foreground">HopIt Labs</span>
          <span className="text-muted-foreground/50">/</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-muted">
                <Code2 className="size-3.5 text-hop" />
                Workspace
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>HopIt Labs</DropdownMenuItem>
              <DropdownMenuItem>Personal</DropdownMenuItem>
              <DropdownMenuItem className="text-muted-foreground">
                + Create workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Global search */}
        <div className="mx-auto flex w-full max-w-xl items-center gap-2 rounded-xl bg-muted/70 px-3 py-2 text-sm ring-1 ring-inset ring-border/60 transition focus-within:ring-2 focus-within:ring-hop/40">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search codebases, files, snapshots, people…"
            className="w-full bg-transparent placeholder:text-muted-foreground focus:outline-none"
            aria-label="Global search"
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            /
          </kbd>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="hidden gap-1.5 rounded-lg bg-hop px-3 text-hop-foreground shadow-sm hover:bg-hop/90 sm:flex"
              >
                <Plus className="size-4" />
                New
                <ChevronDown className="size-3 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem>
                <Code2 className="mr-2 size-4 text-hop" />
                New codebase
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Upload className="mr-2 size-4 text-grape" />
                Upload files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            variant="outline"
            className="hidden gap-1.5 rounded-lg md:flex"
          >
            <Upload className="size-4 text-grape" />
            Upload
          </Button>

          {/* Theme toggle */}
          <button
            onClick={() => setTheme(activeTheme === 'dark' ? 'light' : 'dark')}
            className="rounded-md p-2 hover:bg-muted"
            aria-label="Toggle theme"
          >
            {activeTheme === 'dark' ? (
              <Sun className="size-4 text-hop-amber" />
            ) : (
              <Moon className="size-4" />
            )}
          </button>

          {/* Notifications */}
          <button
            className="relative rounded-md p-2 hover:bg-muted"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-hop" />
          </button>

          <AuthMenu />
        </div>
      </div>
    </header>
  )
}
