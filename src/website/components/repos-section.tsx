'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Clock,
  FileStack,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { navigateToSection } from './navigation'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'

type ReposSectionProps = {
  status: AgentStatusSnapshot
  selectedCodebaseId: string | null
  onSelectCodebase: (codebaseId: string) => void
  onChanged: () => Promise<void>
}

type CodebaseRow = {
  codebase: {
    id: string
    name: string
    ownerId: string | null
  }
  selectedState: {
    id: string | null
    revision: number | null
    effectiveVisibility: string | null
    reviewState: string | null
    mergeState: string | null
  } | null
  access?: {
    role?: string | null
    isOwner?: boolean
    permissions?: string[]
  } | null
  revision: number | null
  updatedAt: string | null
  fileCount: number
  privateFileCount: number
  memberCount: number
}

type CodebaseFilter = 'all' | 'shared' | 'private'

export function ReposSection({
  status,
  selectedCodebaseId,
  onSelectCodebase,
  onChanged,
}: ReposSectionProps) {
  const [filter, setFilter] = React.useState<CodebaseFilter>('all')
  const [codebases, setCodebases] = React.useState<CodebaseRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [creating, setCreating] = React.useState(false)

  const loadCodebases = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/codebases', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Codebase list failed.')
      }
      setCodebases(Array.isArray(body.codebases) ? body.codebases.map(normalizeCodebaseRow) : [])
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Codebase list failed.')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCodebases()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadCodebases])

  const items = React.useMemo(
    () => codebasesWithLiveFallback(codebases, status),
    [codebases, status],
  )
  const filtered = items.filter((codebase) => {
    if (filter === 'private') return codebase.selectedState?.effectiveVisibility === 'private'
    if (filter === 'shared') return codebase.selectedState?.effectiveVisibility !== 'private'
    return true
  })

  async function createCodebase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim()) return

    setCreating(true)
    try {
      const response = await fetch('/api/codebases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Codebase create failed.')
      }

      const nextCodebases = Array.isArray(body.codebases) ? body.codebases.map(normalizeCodebaseRow) : []
      setCodebases(nextCodebases)
      const createdId = body.codebase?.codebase?.id
      if (typeof createdId === 'string') onSelectCodebase(createdId)
      setName('')
      setDescription('')
      setError(null)
      await onChanged()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Codebase create failed.')
    } finally {
      setCreating(false)
    }
  }

  async function renameCodebase(codebase: CodebaseRow) {
    const nextName = window.prompt('Codebase name', codebase.codebase.name)?.trim()
    if (!nextName || nextName === codebase.codebase.name) return
    await updateCodebase(codebase.codebase.id, { name: nextName })
  }

  async function deleteCodebase(codebase: CodebaseRow) {
    if (!window.confirm(`Delete ${codebase.codebase.name}? This removes the cloud codebase and all related records.`)) return

    await updateCodebase(codebase.codebase.id, {}, 'DELETE')
    if (selectedCodebaseId === codebase.codebase.id) {
      const remaining = codebases.filter((row) => row.codebase.id !== codebase.codebase.id)
      if (remaining[0]) onSelectCodebase(remaining[0].codebase.id)
    }
  }

  async function updateCodebase(
    codebaseId: string,
    payload: Record<string, unknown>,
    method: 'PATCH' | 'DELETE' = 'PATCH',
  ) {
    try {
      const response = await fetch('/api/codebases', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codebaseId, ...payload }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Codebase update failed.')
      }
      setCodebases(Array.isArray(body.codebases) ? body.codebases.map(normalizeCodebaseRow) : [])
      setError(null)
      await onChanged()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Codebase update failed.')
    }
  }

  return (
    <section
      aria-label="Codebases"
      className="panel-surface flex flex-col rounded-xl border border-border shadow-sm"
    >
      <SectionHeader
        count={items.length}
        filter={filter}
        setFilter={setFilter}
        name={name}
        description={description}
        creating={creating}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onCreate={createCodebase}
      />

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs font-medium text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {filtered.length > 0 ? (
          filtered.map((codebase, i) => (
            <CodebaseCard
              key={codebase.codebase.id}
              codebase={codebase}
              index={i}
              selected={selectedCodebaseId === codebase.codebase.id || status.codebaseId === codebase.codebase.id}
              onSelect={() => onSelectCodebase(codebase.codebase.id)}
              onRename={() => renameCodebase(codebase)}
              onDelete={() => deleteCodebase(codebase)}
            />
          ))
        ) : (
          <EmptyCodebases loading={loading} />
        )}
      </div>
    </section>
  )
}

function SectionHeader({
  count,
  filter,
  setFilter,
  name,
  description,
  creating,
  onNameChange,
  onDescriptionChange,
  onCreate,
}: {
  count: number
  filter: CodebaseFilter
  setFilter: (f: CodebaseFilter) => void
  name: string
  description: string
  creating: boolean
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Codebases</h2>
            <Badge variant="secondary" className="rounded-full bg-hop/10 text-hop">
              {count}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">Create, select, share, and manage cloud-backed repositories.</p>
        </div>

        <form onSubmit={onCreate} className="flex w-full flex-col gap-2 lg:max-w-2xl">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
            <input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="New codebase name"
              className="min-h-9 min-w-0 rounded-md border border-border/70 bg-background px-3 text-xs outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            />
            <input
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="Description"
              className="min-h-9 min-w-0 rounded-md border border-border/70 bg-background px-3 text-xs outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            />
            <Button size="sm" disabled={creating || !name.trim()} className="gap-1.5 rounded-md">
              <Plus className="size-3.5" />
              {creating ? 'Creating' : 'New'}
            </Button>
          </div>
        </form>
      </div>

      <div className="flex w-fit items-center rounded-md border border-border/60 bg-muted/50 p-0.5">
        {(['all', 'shared', 'private'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium capitalize transition',
              filter === f
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  )
}

function EmptyCodebases({ loading }: { loading: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-6 text-center md:col-span-2">
      <p className="text-sm font-medium">{loading ? 'Loading codebases' : 'No codebases found'}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Create one here, or import a local folder with the HopIt agent.
      </p>
    </div>
  )
}

function CodebaseCard({
  codebase,
  index,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  codebase: CodebaseRow
  index: number
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const visibility = codebase.selectedState?.effectiveVisibility ?? 'private'
  const role = codebase.access?.role ?? 'member'
  const latestRevision = codebase.revision ?? codebase.selectedState?.revision ?? 0

  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.25, ease: 'easeOut' }}
      className={cn(
        'group relative flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 transition duration-200 hover:border-primary/40 hover:shadow-md',
        selected ? 'border-primary/55 ring-2 ring-primary/10' : 'border-border',
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-primary-foreground shadow-sm">
              {codebase.codebase.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">{role}/</span>
                <h3 className="truncate text-sm font-bold text-foreground transition group-hover:text-primary">
                  {codebase.codebase.name}
                </h3>
                {visibility === 'private' && <Lock className="size-3 text-muted-foreground" />}
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {codebase.codebase.id}
              </p>
            </div>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted group-hover:opacity-100"
                aria-label="Codebase actions"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={onRename}>
                <Pencil className="mr-2 size-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  onSelect()
                  navigateToSection('members')
                }}
              >
                <Share2 className="mr-2 size-3.5" />
                Share
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[visibility, codebase.selectedState?.reviewState, codebase.selectedState?.mergeState]
            .filter(Boolean)
            .map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-border/40 bg-secondary/80 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground"
              >
                #{tag}
              </span>
            ))}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <History className="size-3 text-primary" />
            rev {latestRevision}
          </span>
          <span className="flex items-center gap-1.5">
            <FileStack className="size-3 text-primary" />
            {codebase.fileCount} files
          </span>
          <span className="flex items-center gap-1.5">
            <Share2 className="size-3 text-primary" />
            {codebase.memberCount} members
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-secondary/35 p-2.5">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-black text-primary-foreground">
          {codebase.codebase.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-foreground">
            {selected ? 'Selected in dashboard' : 'Available codebase'}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {codebase.privateFileCount} private files
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <Clock className="size-2.5" />
          {formatUpdatedAt(codebase.updatedAt)}
        </span>
      </div>
    </motion.article>
  )
}

function normalizeCodebaseRow(value: unknown): CodebaseRow {
  const row = recordValue(value)
  const codebase = recordValue(row.codebase)
  const selectedState = recordValue(row.selectedState)
  const access = recordValue(row.access)

  return {
    codebase: {
      id: stringValue(codebase.id) ?? 'unknown',
      name: stringValue(codebase.name) ?? stringValue(codebase.id) ?? 'Untitled',
      ownerId: stringValue(codebase.ownerId),
    },
    selectedState: selectedState
      ? {
          id: stringValue(selectedState.id),
          revision: numberValue(selectedState.revision),
          effectiveVisibility: stringValue(selectedState.effectiveVisibility),
          reviewState: stringValue(selectedState.reviewState),
          mergeState: stringValue(selectedState.mergeState),
        }
      : null,
    access: access
      ? {
          role: stringValue(access.role),
          isOwner: access.isOwner === true,
          permissions: Array.isArray(access.permissions)
            ? access.permissions.filter((permission): permission is string => typeof permission === 'string')
            : [],
        }
      : null,
    revision: numberValue(row.revision),
    updatedAt: stringValue(row.updatedAt),
    fileCount: numberValue(row.fileCount) ?? 0,
    privateFileCount: numberValue(row.privateFileCount) ?? 0,
    memberCount: numberValue(row.memberCount) ?? 0,
  }
}

function codebasesWithLiveFallback(codebases: CodebaseRow[], status: AgentStatusSnapshot) {
  if (!status.codebaseId || codebases.some((codebase) => codebase.codebase.id === status.codebaseId)) {
    return codebases
  }

  return [
    normalizeCodebaseRow({
      codebase: {
        id: status.codebaseId,
        name: status.codebaseName,
        ownerId: status.requester.id,
      },
      selectedState: {
        id: status.activeChangeSetId,
        revision: revisionNumber(status.cloudRevision),
        effectiveVisibility: status.visibility,
        reviewState: status.reviewState,
        mergeState: status.mergeState,
      },
      access: status.requester,
      revision: revisionNumber(status.cloudRevision),
      updatedAt: status.rawUpdatedAt,
      fileCount: status.fileCount,
      privateFileCount: status.files.filter((file) => file.scope === 'owner-private').length,
      memberCount: status.members.length,
    }),
    ...codebases,
  ]
}

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : 0
}

function formatUpdatedAt(value: string | null) {
  if (!value) return 'unknown'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
