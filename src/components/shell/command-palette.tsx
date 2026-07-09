'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { ArrowDownUp, RefreshCw, CloudDownload, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { navItems } from '@/components/shell/nav'
import { useWorkspace, type AgentCommand } from '@/components/workspace/workspace-provider'
import { useToast } from '@/hooks/use-toast'

type PaletteEntry = {
  id: string
  group: 'Go to' | 'Agent'
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
  run: () => void
}

const agentActions: Array<{
  command: AgentCommand
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
}> = [
  {
    command: 'sync',
    label: 'Sync now',
    description: 'Send pending local writes to the cloud.',
    icon: ArrowDownUp,
    keywords: ['push', 'upload', 'writes'],
  },
  {
    command: 'refresh',
    label: 'Refresh workspace',
    description: 'Pull the latest cloud state to this device.',
    icon: RefreshCw,
    keywords: ['pull', 'update', 'latest'],
  },
  {
    command: 'hydrateWorkspace',
    label: 'Hydrate workspace',
    description: 'Materialize all cloud files locally.',
    icon: CloudDownload,
    keywords: ['download', 'materialize', 'local'],
  },
]

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { status, runCommand } = useWorkspace()
  const { toast } = useToast()
  const [query, setQuery] = React.useState('')
  const [activeIndex, setActiveIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const runAgentCommand = React.useCallback(
    (command: AgentCommand, label: string) => {
      void runCommand(command).then((result) => {
        toast({
          title: result.ok ? label : `${label} failed`,
          description: result.summary ?? result.stderr ?? result.error?.message,
          variant: result.ok ? undefined : 'destructive',
        })
      })
    },
    [runCommand, toast],
  )

  const entries = React.useMemo<PaletteEntry[]>(() => {
    const nav: PaletteEntry[] = navItems.map((item) => ({
      id: `nav-${item.id}`,
      group: 'Go to',
      label: item.label,
      description: item.description,
      icon: item.icon,
      keywords: item.keywords,
      run: () => router.push(item.href),
    }))
    const agent: PaletteEntry[] = status.commandsAvailable
      ? agentActions.map((action) => ({
          id: `agent-${action.command}`,
          group: 'Agent',
          label: action.label,
          description: action.description,
          icon: action.icon,
          keywords: action.keywords,
          run: () => runAgentCommand(action.command, action.label),
        }))
      : []
    return [...nav, ...agent]
  }, [router, runAgentCommand, status.commandsAvailable])

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return entries
    return entries.filter((entry) =>
      [entry.label, entry.description, ...entry.keywords].some((text) =>
        text.toLowerCase().includes(trimmed),
      ),
    )
  }, [entries, query])

  React.useEffect(() => {
    setActiveIndex(0)
  }, [query])

  function select(entry: PaletteEntry | undefined) {
    if (!entry) return
    onOpenChange(false)
    entry.run()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      select(filtered[activeIndex])
    } else if (event.key === 'Escape') {
      onOpenChange(false)
    }
  }

  if (!mounted || !open) return null

  let lastGroup: string | null = null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => onOpenChange(false)}
        className="fixed inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-150"
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-[1.5rem] border border-border bg-popover shadow-[0_32px_100px_rgba(10,19,15,0.3)] animate-in fade-in zoom-in-95 duration-150"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
          className="h-14 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5 scroll-thin">
          {filtered.length === 0 ? (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">No matches.</li>
          ) : (
            filtered.map((entry, index) => {
              const showGroup = entry.group !== lastGroup
              lastGroup = entry.group
              return (
                <React.Fragment key={entry.id}>
                  {showGroup ? (
                    <li aria-hidden className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {entry.group}
                    </li>
                  ) : null}
                  <li
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      select(entry)
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm',
                      index === activeIndex ? 'bg-foreground text-background' : 'text-muted-foreground',
                    )}
                  >
                    <entry.icon className="size-4 shrink-0" />
                    <span className={cn('font-bold', index === activeIndex ? 'text-background' : 'text-foreground')}>{entry.label}</span>
                    <span className={cn('truncate text-xs', index === activeIndex ? 'text-background/65' : 'text-muted-foreground')}>{entry.description}</span>
                  </li>
                </React.Fragment>
              )
            })
          )}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
