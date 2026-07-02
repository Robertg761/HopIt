'use client'

import * as React from 'react'
import {
  Bell,
  ChevronDown,
  Code2,
  Command,
  HardDrive,
  Menu,
  Moon,
  Plus,
  Search,
  ShieldCheck,
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
import { AuthMenu } from '@/website/components/auth-menu'
import {
  dashboardSections,
  navigateToSection,
} from '@/website/components/navigation'

type HeaderProps = {
  onOpenSidebar: () => void
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const { theme, setTheme } = useTheme()
  const activeTheme = theme === 'light' ? 'light' : 'dark'
  const jumpTo = React.useCallback((id: string) => {
    navigateToSection(id)
  }, [])

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-card/[0.88] backdrop-blur-xl">
      <div className="flex h-14 min-w-0 items-center gap-3 px-4 md:px-6">
        {/* Mobile menu */}
        <button
          onClick={onOpenSidebar}
          className="rounded-md p-2 hover:bg-muted"
          aria-label="Open sidebar"
        >
          <Menu className="size-5" />
        </button>

        {/* Breadcrumb / context */}
        <div className="hidden items-center gap-2 md:flex">
          <span className="mono-label text-[10px] font-medium text-muted-foreground">
            HopIt Labs
          </span>
          <span className="text-muted-foreground/50">/</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-sm font-medium text-foreground hover:bg-muted">
                <Code2 className="size-3.5 text-hop" />
                Workspace
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => jumpTo('overview')}>
                Overview
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => jumpTo('codebases')}>
                Codebases
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => jumpTo('members')}>
                Members
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Global search */}
        <GlobalSearch onNavigate={jumpTo} />

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <button
            className="hidden h-8 items-center gap-1.5 rounded-md border border-hop/20 bg-hop/5 px-2.5 text-xs font-medium text-hop lg:flex"
            onClick={() => jumpTo('status')}
          >
            <HardDrive className="size-3.5" />
            Agent
          </button>
          <button
            className="hidden h-8 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground xl:flex"
            onClick={() => jumpTo('status')}
          >
            <ShieldCheck className="size-3.5 text-hop" />
            Private scope
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="hidden h-8 gap-1.5 rounded-md bg-hop px-3 text-hop-foreground shadow-sm hover:bg-hop/90 sm:flex"
              >
                <Plus className="size-4" />
                New
                <ChevronDown className="size-3 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => jumpTo('codebases')}>
                <Code2 className="mr-2 size-4 text-hop" />
                New codebase
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => jumpTo('members')}>
                <Plus className="mr-2 size-4 text-hop" />
                Invite member
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => jumpTo('work-items')}>
                <Command className="mr-2 size-4 text-grape" />
                Create work item
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => jumpTo('files')}>
                <Upload className="mr-2 size-4 text-grape" />
                Import files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            variant="outline"
            className="hidden h-8 gap-1.5 rounded-md md:flex"
            onClick={() => jumpTo('files')}
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
            onClick={() => jumpTo('activity')}
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

function GlobalSearch({ onNavigate }: { onNavigate: (id: string) => void }) {
  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const resultsId = React.useId()
  const normalizedQuery = query.trim().toLowerCase()
  const results = React.useMemo(() => {
    if (!normalizedQuery) return dashboardSections

    return dashboardSections.filter((section) =>
      [section.label, section.description, ...section.keywords]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery])

  React.useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }

      if (event.key === '/' && !isTyping) {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }

    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function navigate(id: string) {
    onNavigate(id)
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
    if (event.key === 'Enter' && results[0]) {
      event.preventDefault()
      navigate(results[0].id)
    }
  }

  return (
    <div ref={rootRef} className="relative mx-auto hidden min-w-0 flex-1 sm:block sm:max-w-2xl">
      <div className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-sm shadow-inner shadow-slate-950/[0.02] transition focus-within:border-hop/50 focus-within:ring-2 focus-within:ring-hop/15">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onSearchKeyDown}
          type="search"
          placeholder="Command + K to search workspace"
          className="min-w-0 flex-1 bg-transparent placeholder:text-muted-foreground focus:outline-none"
          aria-label="Global search"
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-expanded={open}
          role="combobox"
        />
        <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline">
          K
        </kbd>
      </div>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+0.45rem)] z-50 overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-xl">
          <div id={resultsId} role="listbox" className="max-h-[320px] overflow-auto p-1.5 scroll-thin">
            {results.length > 0 ? (
              results.map((section) => {
                const Icon = section.icon
                return (
                  <button
                    key={section.id}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => navigate(section.id)}
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent focus:bg-accent focus:outline-none"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-hop/10 text-hop">
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{section.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {section.description}
                      </span>
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching section
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
