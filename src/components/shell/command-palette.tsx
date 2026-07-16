'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDownUp, RefreshCw, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { accountNavItems, repoPaletteItems } from '@/components/shell/nav'
import { useUnsavedChanges } from '@/components/shell/unsaved-changes-provider'
import { useWorkspace, type AgentCommand } from '@/components/workspace/workspace-provider'
import { useToast } from '@/hooks/use-toast'

type PaletteEntry = {
  id: string
  group: 'Go to' | 'Repository' | 'Agent'
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
]

export function CommandPalette({
  open,
  onOpenChange,
  serviceAdmin = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  serviceAdmin?: boolean
}) {
  const router = useRouter()
  const { status, selectedCodebaseId, runCommand } = useWorkspace()
  const { confirmOrRun } = useUnsavedChanges()
  const { toast } = useToast()
  const [query, setQuery] = React.useState('')
  const [activeIndex, setActiveIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const previouslyFocused = React.useRef<HTMLElement | null>(null)
  const navItems = React.useMemo(() => accountNavItems(serviceAdmin), [serviceAdmin])

  React.useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null
      setQuery('')
      setActiveIndex(0)
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
      run: () => confirmOrRun(() => router.push(item.href)),
    }))
    const codebaseId = selectedCodebaseId ?? status.codebaseId
    const repo: PaletteEntry[] = codebaseId
      ? repoPaletteItems(codebaseId).map((item) => ({
          id: item.id,
          group: 'Repository',
          label: item.label,
          description: item.description,
          icon: item.icon,
          keywords: item.keywords,
          run: () => confirmOrRun(() => router.push(item.href)),
        }))
      : []
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
    return [...nav, ...repo, ...agent]
  }, [confirmOrRun, navItems, router, runAgentCommand, selectedCodebaseId, status.codebaseId, status.commandsAvailable])

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

  React.useEffect(() => {
    if (filtered.length === 0) {
      setActiveIndex(0)
      return
    }
    setActiveIndex((index) => Math.min(index, filtered.length - 1))
  }, [filtered.length])

  const activeOptionId = filtered[activeIndex] ? optionId(filtered[activeIndex].id) : undefined

  React.useEffect(() => {
    if (!open || !activeOptionId) return
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionId, open])

  function select(entry: PaletteEntry | undefined) {
    if (!entry) return
    onOpenChange(false)
    entry.run()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length === 0 ? 0 : Math.min(index + 1, filtered.length - 1))
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

  let lastGroup: string | null = null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            previouslyFocused.current?.focus()
          }}
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-md border border-border bg-popover shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search pages and actions…"
              className="h-14 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              role="combobox"
              aria-expanded={open}
              aria-controls="command-palette-list"
              aria-activedescendant={activeOptionId}
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
                      id={optionId(entry.id)}
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
                      <entry.icon className="size-4 shrink-0" aria-hidden />
                      <span className={cn('font-bold', index === activeIndex ? 'text-background' : 'text-foreground')}>{entry.label}</span>
                      <span className={cn('truncate text-xs', index === activeIndex ? 'text-background/65' : 'text-muted-foreground')}>{entry.description}</span>
                    </li>
                  </React.Fragment>
                )
              })
            )}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function optionId(entryId: string) {
  return `command-palette-option-${entryId.replace(/[^A-Za-z0-9_-]/g, '-')}`
}
