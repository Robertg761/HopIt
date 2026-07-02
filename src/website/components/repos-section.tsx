'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  Clock,
  FileStack,
  FolderPlus,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
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
import type {
  AgentCommand,
  AgentCommandPayload,
  AgentCommandResult,
} from '@/website/hooks/use-agent-status'

type ReposSectionProps = {
  status: AgentStatusSnapshot
  selectedCodebaseId: string | null
  onSelectCodebase: (codebaseId: string) => void
  onChanged: () => Promise<void>
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
  runningCommand: AgentCommand | null
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
    conflictState: string | null
  } | null
  access?: {
    role?: string | null
    isOwner?: boolean
    membershipSource?: string | null
    permissions?: string[]
    visibleFileCount?: number | null
    hiddenFileCount?: number | null
  } | null
  workspace?: {
    attached: boolean
    path: string | null
    hydrationState: string
    materialization: string | null
  } | null
  remoteUpdate?: {
    state: string | null
    delivery: string | null
    graphRevision: number | null
    materializedRevision: number | null
    behindByRevisions: number | null
    localHydrationState: string | null
  } | null
  revision: number | null
  updatedAt: string | null
  fileCount: number
  privateFileCount: number
  memberCount: number
}

type WorkspaceDiscoverySummary = {
  ok: boolean
  root: {
    path: string | null
    exists: boolean
    index: {
      exists?: boolean
      codebaseCount?: number | null
    } | null
  } | null
  cloud: {
    service: string | null
    discovery: string | null
    error: string | null
  } | null
  error: string | null
}

type CodebaseFilter = 'all' | 'shared' | 'private'

export function ReposSection({
  status,
  selectedCodebaseId,
  onSelectCodebase,
  onChanged,
  runCommand,
  runningCommand,
}: ReposSectionProps) {
  const [filter, setFilter] = React.useState<CodebaseFilter>('all')
  const [codebases, setCodebases] = React.useState<CodebaseRow[]>([])
  const [workspaceDiscovery, setWorkspaceDiscovery] = React.useState<WorkspaceDiscoverySummary | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [attachingCodebaseId, setAttachingCodebaseId] = React.useState<string | null>(null)
  const [settingUpCodebaseId, setSettingUpCodebaseId] = React.useState<string | null>(null)
  const [hydratingCodebaseId, setHydratingCodebaseId] = React.useState<string | null>(null)
  const [dehydratingCodebaseId, setDehydratingCodebaseId] = React.useState<string | null>(null)

  const loadCodebases = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/codebases', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Codebase list failed.')
      }
      setCodebases(Array.isArray(body.codebases) ? body.codebases.map(normalizeCodebaseRow) : [])
      setWorkspaceDiscovery(normalizeWorkspaceDiscovery(body.workspaceDiscovery))
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
  const setupTarget = items.find((codebase) => codebase.workspace?.attached !== true) ?? null

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

  async function attachCodebase(codebase: CodebaseRow) {
    const codebaseId = codebase.codebase.id

    if (!status.commandsAvailable) {
      setError('Workspace attach requires the local HopIt agent.')
      return
    }

    setAttachingCodebaseId(codebaseId)
    onSelectCodebase(codebaseId)

    try {
      const result = await runCommand('attachWorkspace', { codebaseId })
      if (!result.ok) {
        throw new Error(result.summary || result.stderr || result.error?.message || 'Workspace attach failed.')
      }

      await loadCodebases()
      await onChanged()
      setError(null)
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : 'Workspace attach failed.')
    } finally {
      setAttachingCodebaseId(null)
    }
  }

  async function setupCodebase(codebase: CodebaseRow) {
    const codebaseId = codebase.codebase.id

    if (!status.commandsAvailable) {
      setError('Workspace setup requires the local HopIt agent.')
      return
    }

    setSettingUpCodebaseId(codebaseId)
    onSelectCodebase(codebaseId)

    try {
      const result = await runCommand('setupWorkspace', { codebaseId })
      if (!result.ok) {
        throw new Error(result.summary || result.stderr || result.error?.message || 'Workspace setup failed.')
      }

      await loadCodebases()
      await onChanged()
      setError(null)
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Workspace setup failed.')
    } finally {
      setSettingUpCodebaseId(null)
    }
  }

  async function hydrateCodebase(codebase: CodebaseRow) {
    const codebaseId = codebase.codebase.id

    if (!status.commandsAvailable) {
      setError('Workspace hydrate requires the local HopIt agent.')
      return
    }

    setHydratingCodebaseId(codebaseId)
    onSelectCodebase(codebaseId)

    try {
      const result = await runCommand('hydrateWorkspace', { codebaseId })
      if (!result.ok) {
        throw new Error(result.summary || result.stderr || result.error?.message || 'Workspace hydrate failed.')
      }

      await loadCodebases()
      await onChanged()
      setError(null)
    } catch (hydrateError) {
      setError(hydrateError instanceof Error ? hydrateError.message : 'Workspace hydrate failed.')
    } finally {
      setHydratingCodebaseId(null)
    }
  }

  async function dehydrateCodebase(codebase: CodebaseRow) {
    const codebaseId = codebase.codebase.id

    if (!status.commandsAvailable) {
      setError('Workspace dehydrate requires the local HopIt agent.')
      return
    }

    setDehydratingCodebaseId(codebaseId)
    onSelectCodebase(codebaseId)

    try {
      const result = await runCommand('dehydrateWorkspace', { codebaseId })
      if (!result.ok) {
        throw new Error(result.summary || result.stderr || result.error?.message || 'Workspace dehydrate failed.')
      }

      await loadCodebases()
      await onChanged()
      setError(null)
    } catch (dehydrateError) {
      setError(dehydrateError instanceof Error ? dehydrateError.message : 'Workspace dehydrate failed.')
    } finally {
      setDehydratingCodebaseId(null)
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

      {setupTarget ? (
        <WorkspaceSetupBanner
          codebase={setupTarget}
          discovery={workspaceDiscovery}
          settingUp={settingUpCodebaseId === setupTarget.codebase.id}
          disabledReason={workspaceActionDisabledReason(status, runningCommand, {
            attachingCodebaseId,
            settingUpCodebaseId,
            hydratingCodebaseId,
            dehydratingCodebaseId,
          })}
          onSetup={() => setupCodebase(setupTarget)}
        />
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
              onAttach={() => attachCodebase(codebase)}
              onHydrate={() => hydrateCodebase(codebase)}
              onDehydrate={() => dehydrateCodebase(codebase)}
              attaching={attachingCodebaseId === codebase.codebase.id}
              hydrating={hydratingCodebaseId === codebase.codebase.id}
              dehydrating={dehydratingCodebaseId === codebase.codebase.id}
              actionDisabledReason={workspaceActionDisabledReason(status, runningCommand, {
                attachingCodebaseId,
                settingUpCodebaseId,
                hydratingCodebaseId,
                dehydratingCodebaseId,
              })}
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

function WorkspaceSetupBanner({
  codebase,
  discovery,
  settingUp,
  disabledReason,
  onSetup,
}: {
  codebase: CodebaseRow
  discovery: WorkspaceDiscoverySummary | null
  settingUp: boolean
  disabledReason: string | null
  onSetup: () => void
}) {
  const rootPath = discovery?.root?.path ?? codebase.workspace?.path ?? 'Workspace Root'
  const fileCount = codebase.fileCount || codebase.access?.visibleFileCount || 0
  const rootReady = discovery?.root?.exists === true

  return (
    <div className="border-b border-border/60 bg-primary/5 px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderPlus className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Set up {codebase.codebase.name}
            </p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {rootReady ? 'Workspace Root ready' : 'Workspace Root pending'} / {formatStateLabel(codebase.workspace?.hydrationState ?? 'not-attached')} / {fileCount} files
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
              {rootPath}
            </p>
          </div>
        </div>

        <Button
          type="button"
          size="sm"
          disabled={Boolean(disabledReason) || settingUp}
          title={disabledReason ?? 'Set up Workspace Root'}
          onClick={onSetup}
          className="h-8 shrink-0 gap-1.5 rounded-md px-3 text-xs"
        >
          <FolderPlus className={cn('size-3.5', settingUp && 'animate-pulse')} />
          {settingUp ? 'Setting Up' : 'Set Up'}
        </Button>
      </div>
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
  onAttach,
  onHydrate,
  onDehydrate,
  attaching,
  hydrating,
  dehydrating,
  actionDisabledReason,
}: {
  codebase: CodebaseRow
  index: number
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onAttach: () => void
  onHydrate: () => void
  onDehydrate: () => void
  attaching: boolean
  hydrating: boolean
  dehydrating: boolean
  actionDisabledReason: string | null
}) {
  const visibility = codebase.selectedState?.effectiveVisibility ?? 'private'
  const role = codebase.access?.role ?? 'member'
  const latestRevision = codebase.revision ?? codebase.selectedState?.revision ?? 0
  const permissions = new Set(codebase.access?.permissions ?? [])
  const canRename = permissions.has('write')
  const canShare = permissions.has('invite') || permissions.has('manage_members')
  const canDelete = codebase.access?.isOwner === true
  const workspaceState = codebase.workspace?.hydrationState ?? 'cloud-only'
  const remoteUpdateState = codebase.remoteUpdate?.state ?? 'cloud-head-ready'
  const workspaceLabel = formatStateLabel(workspaceState)
  const isAttached = codebase.workspace?.attached === true
  const canHydrate = isAttached && workspaceState !== 'materialized'
  const canDehydrate = isAttached && workspaceState !== 'metadata-only'
  const behindByRevisions = codebase.remoteUpdate?.behindByRevisions
  const remoteUpdateLabel =
    behindByRevisions === null || behindByRevisions === undefined
      ? formatStateLabel(remoteUpdateState)
      : behindByRevisions > 0
        ? `${behindByRevisions} behind`
        : 'current'

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
              <DropdownMenuItem disabled={!canRename} onSelect={onRename}>
                <Pencil className="mr-2 size-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canShare}
                onSelect={() => {
                  onSelect()
                  navigateToSection('members')
                }}
              >
                <Share2 className="mr-2 size-3.5" />
                Share
              </DropdownMenuItem>
              {canDelete ? (
                <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 size-3.5" />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[visibility, workspaceState, remoteUpdateState, codebase.selectedState?.reviewState, codebase.selectedState?.mergeState, codebase.selectedState?.conflictState]
            .filter(Boolean)
            .map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-border/40 bg-secondary/80 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground"
              >
                #{formatStateLabel(String(tag))}
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
          <span className="flex items-center gap-1.5">
            <RefreshCcw className="size-3 text-primary" />
            {remoteUpdateLabel}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-secondary/35 p-2.5">
        <div className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full text-[9px] font-black',
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}>
          {remoteUpdateState === 'ready' || remoteUpdateLabel === 'current' ? (
            <CheckCircle2 className="size-3.5" />
          ) : (
            codebase.codebase.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-foreground">
            {selected ? 'Selected in dashboard' : 'Available codebase'}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {workspaceLabel} / {codebase.access?.membershipSource ?? role} / {codebase.privateFileCount} private files
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isAttached ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(actionDisabledReason) || attaching}
              title={actionDisabledReason ?? 'Attach to Workspace Root'}
              onClick={onAttach}
              className="h-7 gap-1.5 rounded-md px-2 text-[10px]"
            >
              <FolderPlus className={cn('size-3', attaching && 'animate-pulse')} />
              <span>{attaching ? 'Attaching' : 'Attach'}</span>
            </Button>
          ) : null}
          {canHydrate ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(actionDisabledReason) || hydrating}
              title={actionDisabledReason ?? 'Hydrate local workspace'}
              onClick={onHydrate}
              className="h-7 gap-1.5 rounded-md px-2 text-[10px]"
            >
              <RefreshCcw className={cn('size-3', hydrating && 'animate-spin')} />
              <span>{hydrating ? 'Hydrating' : 'Hydrate'}</span>
            </Button>
          ) : null}
          {canDehydrate ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={Boolean(actionDisabledReason) || dehydrating}
              title={actionDisabledReason ?? 'Return to metadata-only'}
              onClick={onDehydrate}
              className="h-7 gap-1.5 rounded-md px-2 text-[10px]"
            >
              <FileStack className={cn('size-3', dehydrating && 'animate-pulse')} />
              <span>{dehydrating ? 'Dehydrating' : 'Metadata'}</span>
            </Button>
          ) : null}
          <span className="hidden items-center gap-1 text-[10px] font-medium text-muted-foreground sm:flex">
            <Clock className="size-2.5" />
            {formatUpdatedAt(codebase.updatedAt)}
          </span>
        </div>
      </div>
    </motion.article>
  )
}

function workspaceActionDisabledReason(
  status: AgentStatusSnapshot,
  runningCommand: AgentCommand | null,
  active: {
    attachingCodebaseId: string | null
    settingUpCodebaseId: string | null
    hydratingCodebaseId: string | null
    dehydratingCodebaseId: string | null
  },
) {
  if (!status.commandsAvailable) return 'Workspace actions require the local HopIt agent.'
  if (runningCommand) return `Running ${runningCommand}`
  if (active.settingUpCodebaseId) return 'Workspace setup is running.'
  if (active.attachingCodebaseId) return 'Another codebase is attaching.'
  if (active.hydratingCodebaseId) return 'Workspace hydrate is running.'
  if (active.dehydratingCodebaseId) return 'Workspace dehydrate is running.'
  return null
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
          conflictState: stringValue(selectedState.conflictState),
        }
      : null,
    access: access
      ? {
          role: stringValue(access.role),
          isOwner: access.isOwner === true,
          membershipSource: stringValue(access.membershipSource),
          permissions: Array.isArray(access.permissions)
            ? access.permissions.filter((permission): permission is string => typeof permission === 'string')
            : [],
          visibleFileCount: numberValue(access.visibleFileCount),
          hiddenFileCount: numberValue(access.hiddenFileCount),
        }
      : null,
    workspace: normalizeWorkspace(row),
    remoteUpdate: normalizeRemoteUpdate(row.remoteUpdate),
    revision: numberValue(row.revision),
    updatedAt: stringValue(row.updatedAt),
    fileCount: numberValue(row.fileCount) ?? 0,
    privateFileCount: numberValue(row.privateFileCount) ?? 0,
    memberCount: numberValue(row.memberCount) ?? 0,
  }
}

function codebasesWithLiveFallback(codebases: CodebaseRow[], status: AgentStatusSnapshot) {
  if (!status.codebaseId) {
    return codebases
  }

  const liveCodebase = liveCodebaseRow(status)
  if (codebases.some((codebase) => codebase.codebase.id === status.codebaseId)) {
    return codebases.map((codebase) =>
      codebase.codebase.id === status.codebaseId ? mergeLiveCodebaseRow(codebase, liveCodebase) : codebase,
    )
  }

  return [liveCodebase, ...codebases]
}

function liveCodebaseRow(status: AgentStatusSnapshot) {
  const hasLocalWorkspaceStatus = status.backend === 'local-agent'
  return normalizeCodebaseRow({
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
        conflictState: status.conflictState,
      },
      access: status.requester,
      workspace: hasLocalWorkspaceStatus
        ? {
            attached: true,
            path: status.managedWorkspacePath,
            hydrationState: status.workspaceHydrationState,
            materialization: status.cacheState === 'ready' ? 'managed-folder' : status.cacheState,
          }
        : null,
      remoteUpdate: hasLocalWorkspaceStatus
        ? {
            state:
              status.remoteBehindByRevisions === null
                ? status.remotePullMode
                : status.remoteBehindByRevisions > 0
                  ? 'behind'
                  : 'ready',
            delivery: status.remotePullMode,
            graphRevision: revisionNumber(status.cloudRevision),
            materializedRevision: status.workspaceMaterializedRevision,
            behindByRevisions: status.remoteBehindByRevisions,
            localHydrationState: status.workspaceHydrationState,
          }
        : null,
      revision: revisionNumber(status.cloudRevision),
      updatedAt: status.rawUpdatedAt,
      fileCount: status.fileCount,
      privateFileCount: status.files.filter((file) => file.scope === 'owner-private').length,
      memberCount: status.members.length,
    })
}

function mergeLiveCodebaseRow(codebase: CodebaseRow, liveCodebase: CodebaseRow): CodebaseRow {
  return {
    ...codebase,
    access: liveCodebase.access ?? codebase.access,
    workspace: liveCodebase.workspace ?? codebase.workspace,
    remoteUpdate: liveCodebase.remoteUpdate ?? codebase.remoteUpdate,
    selectedState: liveCodebase.selectedState ?? codebase.selectedState,
    revision: liveCodebase.revision ?? codebase.revision,
    updatedAt: liveCodebase.updatedAt ?? codebase.updatedAt,
    fileCount: liveCodebase.fileCount || codebase.fileCount,
    privateFileCount: liveCodebase.privateFileCount || codebase.privateFileCount,
    memberCount: Math.max(codebase.memberCount, liveCodebase.memberCount),
  }
}

function normalizeWorkspace(row: Record<string, unknown>): CodebaseRow['workspace'] {
  const workspace = recordValue(row.workspace)
  const hydration = recordValue(workspace.hydration)
  const path = stringValue(workspace.path)
  const hydrationState = stringValue(hydration.state) ?? stringValue(row.materialization) ?? 'cloud-only'
  if (!path && hydrationState === 'cloud-only') return null
  const attachedState = !['cloud-only', 'not-attached', 'not_attached', 'not-materialized', 'not_materialized'].includes(hydrationState)

  return {
    attached: Boolean(row.attached) || attachedState,
    path,
    hydrationState,
    materialization: stringValue(row.materialization),
  }
}

function normalizeWorkspaceDiscovery(value: unknown): WorkspaceDiscoverySummary | null {
  const discovery = recordValue(value)
  if (Object.keys(discovery).length === 0) return null
  const root = recordValue(discovery.root)
  const cloud = recordValue(discovery.cloud)
  const index = recordValue(root.index)
  return {
    ok: discovery.ok === true,
    root: Object.keys(root).length > 0
      ? {
          path: stringValue(root.path),
          exists: root.exists === true,
          index: Object.keys(index).length > 0
            ? {
                exists: index.exists === true,
                codebaseCount: numberValue(index.codebaseCount),
              }
            : null,
        }
      : null,
    cloud: Object.keys(cloud).length > 0
      ? {
          service: stringValue(cloud.service),
          discovery: stringValue(cloud.discovery),
          error: stringValue(cloud.error),
        }
      : null,
    error: stringValue(discovery.error),
  }
}

function normalizeRemoteUpdate(value: unknown): CodebaseRow['remoteUpdate'] {
  const remoteUpdate = recordValue(value)
  if (Object.keys(remoteUpdate).length === 0) return null

  return {
    state: stringValue(remoteUpdate.state),
    delivery: stringValue(remoteUpdate.delivery),
    graphRevision: numberValue(remoteUpdate.graphRevision),
    materializedRevision: numberValue(remoteUpdate.materializedRevision),
    behindByRevisions: numberValue(remoteUpdate.behindByRevisions),
    localHydrationState: stringValue(remoteUpdate.localHydrationState),
  }
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

function formatStateLabel(value: string) {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
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
