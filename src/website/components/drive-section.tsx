'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  CloudDownload,
  CloudUpload,
  FilePlus2,
  Grid3x3,
  List,
  Lock,
  MoreHorizontal,
  Pin,
  PinOff,
  Save,
  Search,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  fileTypeColorMap,
  fileTypeIconMap,
  type DriveFile,
} from './data'
import { cn } from '@/lib/utils'
import type { AgentFile, AgentStatusSnapshot } from '@/website/lib/agent-status'
import type { AgentCommand, AgentCommandPayload, AgentCommandResult } from '@/website/hooks/use-agent-status'

const folderColorMap: Record<string, string> = {
  hop: 'bg-primary/10 text-primary border border-primary/20',
  grape: 'bg-grape/10 text-grape border border-grape/20',
  amber: 'bg-hop-amber/10 text-hop-amber border border-hop-amber/20',
  sky: 'bg-sky-500/10 text-sky-500 border border-sky-500/20',
}

type DriveSectionProps = {
  status: AgentStatusSnapshot
  onChanged: () => Promise<void>
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
  runningCommand: AgentCommand | null
}

type DriveScopeFilter = 'all' | 'shared' | 'private'

type DriveBrowserFile = DriveFile & {
  path: string
  directory: string
  scope: AgentFile['scope']
  revision: number | null
  local: AgentFile['local']
}

type DriveFolder = DriveFile & {
  directory: string
}

export function DriveSection({ status, onChanged, runCommand, runningCommand }: DriveSectionProps) {
  const [view, setView] = React.useState<'grid' | 'list'>('grid')
  const [activeFolder, setActiveFolder] = React.useState('all')
  const [scopeFilter, setScopeFilter] = React.useState<DriveScopeFilter>('all')
  const [fileQuery, setFileQuery] = React.useState('')
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState('')
  const [newFilePath, setNewFilePath] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const filteredAgentFiles = React.useMemo(
    () => filterAgentFiles(status.files, activeFolder, scopeFilter, fileQuery),
    [activeFolder, fileQuery, scopeFilter, status.files],
  )
  const liveFiles = filteredAgentFiles.map(agentFileToDriveFile)
  const liveFolders = status.files.length > 0 ? agentFoldersFromFiles(status.files) : []
  const selectedFile = status.files.find((file) => file.path === selectedPath) ?? null
  const canEditSelectedFile =
    Boolean(status.codebaseId) &&
    status.requester.permissions.includes('write') &&
    selectedFile?.kind === 'file' &&
    selectedFile.encoding === 'utf8' &&
    selectedFile.contentStorage !== 'object-blob'
  const fileCountLabel = `${status.files.length} files`
  const privateFileCount = status.files.filter((file) => file.scope === 'owner-private').length
  const sharedFileCount = status.files.length - privateFileCount
  const localFileCount = status.files.filter((file) => file.local.hydrated).length
  const prunableFileCount = status.files.filter((file) => file.local.prunable).length
  const cacheActionRunning =
    runningCommand === 'hydratePath' ||
    runningCommand === 'pruneWorkspace' ||
    runningCommand === 'pinPath' ||
    runningCommand === 'unpinPath'
  const cacheActionsDisabled = !status.commandsAvailable || Boolean(runningCommand)

  async function saveFile() {
    if (!status.codebaseId || !selectedFile || !canEditSelectedFile) return
    await mutateFile({
      path: selectedFile.path,
      content: draft,
      baseRevision: selectedFile.revision,
    })
  }

  async function createFile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const path = newFilePath.trim()
    if (!status.codebaseId || !path) return

    await mutateFile({
      path,
      content: '',
      baseRevision: null,
    })
    setSelectedPath(path)
    setNewFilePath('')
  }

  async function mutateFile(payload: { path: string; content: string; baseRevision: number | null }) {
    if (!status.codebaseId) return

    setSaving(true)
    try {
      const response = await fetch('/api/codebase-files', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codebaseId: status.codebaseId,
          ...payload,
        }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'File save failed.')
      }
      setError(null)
      await onChanged()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'File save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function runLocalCacheCommand(command: AgentCommand, payload: AgentCommandPayload) {
    if (!status.codebaseId || cacheActionsDisabled) return

    try {
      const result = await runCommand(command, payload)
      if (!result.ok) {
        throw new Error(result.summary || result.stderr || result.error?.message || 'Local cache command failed.')
      }
      setError(null)
      await onChanged()
    } catch (cacheError) {
      setError(cacheError instanceof Error ? cacheError.message : 'Local cache command failed.')
    }
  }

  function hydrateSelectedFile() {
    if (!selectedFile) return
    return runLocalCacheCommand('hydratePath', { path: selectedFile.path })
  }

  function pruneSelectedFile() {
    if (!selectedFile) return
    return runLocalCacheCommand('pruneWorkspace', { path: selectedFile.path, execute: true })
  }

  function pinSelectedFile() {
    if (!selectedFile) return
    return runLocalCacheCommand('pinPath', { path: selectedFile.path })
  }

  function unpinSelectedFile() {
    if (!selectedFile) return
    return runLocalCacheCommand('unpinPath', { path: selectedFile.path })
  }

  async function selectFile(path: string) {
    const file = status.files.find((entry) => entry.path === path) ?? null
    setSelectedPath(path)
    setDraft(file?.contentPreview ?? '')
    if (!status.codebaseId || !file || file.kind !== 'file' || file.encoding !== 'utf8') return

    setLoadingFile(true)
    try {
      const params = new URLSearchParams({
        codebaseId: status.codebaseId,
        path,
      })
      const response = await fetch(`/api/codebase-files?${params.toString()}`, {
        cache: 'no-store',
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'File read failed.')
      }
      if (typeof body.file?.content === 'string') setDraft(body.file.content)
      setError(null)
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'File read failed.')
    } finally {
      setLoadingFile(false)
    }
  }

  return (
    <section className="panel-surface flex flex-col rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-foreground">Files</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
              {fileCountLabel}
            </span>
            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-600">
              {localFileCount} local
            </span>
            <span className="rounded-full bg-hop-amber/10 px-2 py-0.5 text-[10px] font-bold text-hop-amber">
              {prunableFileCount} freeable
            </span>
          </div>
          <nav
            aria-label="Files path"
            className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"
          >
            <span>Workspace Root</span>
            <ChevronRight className="size-3" />
            <span className="font-semibold text-foreground">{status.codebaseName}</span>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5">
            <button
              onClick={() => setView('grid')}
              className={cn(
                'rounded-md p-1.5 transition cursor-pointer',
                view === 'grid' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
              )}
              aria-label="Grid view"
            >
              <Grid3x3 className="size-3.5" />
            </button>
            <button
              onClick={() => setView('list')}
              className={cn(
                'rounded-md p-1.5 transition cursor-pointer',
                view === 'list' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
              )}
              aria-label="List view"
            >
              <List className="size-3.5" />
            </button>
          </div>
          <Button
            size="sm"
            disabled
            className="gap-1.5 rounded-lg bg-primary text-white hover:bg-primary/95 shadow-sm"
          >
            <CloudUpload className="size-3.5" />
            Import
          </Button>
        </div>
      </div>

      <div className="border-b border-border/60 px-4 py-3 bg-secondary/15">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/65 bg-card px-3 py-1.5 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 lg:max-w-sm lg:flex-1">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Search files"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ScopeFilterButton
              active={scopeFilter === 'all'}
              label="All"
              count={status.files.length}
              onClick={() => setScopeFilter('all')}
            />
            <ScopeFilterButton
              active={scopeFilter === 'shared'}
              label="Shared"
              count={sharedFileCount}
              onClick={() => setScopeFilter('shared')}
            />
            <ScopeFilterButton
              active={scopeFilter === 'private'}
              label="Private"
              count={privateFileCount}
              onClick={() => setScopeFilter('private')}
            />
          </div>
        </div>
      </div>

      {/* Folders */}
      {liveFolders.length > 0 ? (
        <div className="px-4 pt-4 border-b border-border/40 pb-4">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Folders
            </p>
            <button
              type="button"
              onClick={() => setActiveFolder('all')}
              className={cn(
                'rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-wide transition cursor-pointer',
                activeFolder === 'all'
                  ? 'bg-primary/10 text-primary border border-primary/25 shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              All files
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {liveFolders.map((f, i) => (
              <motion.button
                key={f.id}
                type="button"
                onClick={() => setActiveFolder(f.directory)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.3 }}
                className={cn(
                  'group flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/50 p-3 text-left transition duration-200 hover:border-primary/45 hover:bg-primary/5 cursor-pointer',
                  activeFolder === f.directory && 'border-primary/50 bg-primary/8 shadow-sm ring-1 ring-primary/25',
                )}
              >
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg shadow-sm',
                    folderColorMap[f.color ?? 'hop'],
                  )}
                >
                  <FolderGlyph />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground group-hover:text-primary">{f.name}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    <Users className="mr-1 inline size-2.5 text-primary" />
                    {f.sharedWith} files
                  </p>
                </div>
              </motion.button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Files */}
      <div className="p-4">
        <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Files
            </p>
            <span className="text-[10.5px] font-semibold text-muted-foreground">{liveFiles.length} visible</span>
          </div>
          <form onSubmit={createFile} className="flex min-w-0 gap-2 lg:max-w-md lg:flex-1">
            <input
              value={newFilePath}
              onChange={(event) => setNewFilePath(event.target.value)}
              placeholder="path/to/file.txt"
              className="min-h-9 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-3 text-xs outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            />
            <Button
              size="sm"
              disabled={!status.codebaseId || saving || !newFilePath.trim()}
              className="gap-1.5 rounded-md"
            >
              <FilePlus2 className="size-3.5" />
              Create
            </Button>
          </form>
        </div>
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive">
            {error}
          </div>
        ) : null}
        {liveFiles.length === 0 ? (
          <EmptyFiles activeFolder={activeFolder} />
        ) : view === 'grid' ? (
          <FileGrid files={liveFiles} selectedPath={selectedPath} onSelect={selectFile} />
        ) : (
          <FileList files={liveFiles} selectedPath={selectedPath} onSelect={selectFile} />
        )}
        <FileEditor
          file={selectedFile}
          draft={draft}
          saving={saving}
          loading={loadingFile}
          canEdit={canEditSelectedFile}
          cacheActionRunning={cacheActionRunning}
          cacheActionsDisabled={cacheActionsDisabled}
          onDraftChange={setDraft}
          onSave={saveFile}
          onHydrate={hydrateSelectedFile}
          onPrune={pruneSelectedFile}
          onPin={pinSelectedFile}
          onUnpin={unpinSelectedFile}
        />
      </div>
    </section>
  )
}

function ScopeFilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-xs font-semibold transition border cursor-pointer',
        active
          ? 'bg-primary/10 text-primary border-primary/25 shadow-sm'
          : 'bg-muted/40 text-muted-foreground border-transparent hover:text-foreground hover:bg-muted',
      )}
    >
      {label}
      <span className="ml-1 text-[9.5px] opacity-75 font-mono">({count})</span>
    </button>
  )
}

function EmptyFiles({ activeFolder }: { activeFolder: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-6 text-center">
      <p className="text-sm font-medium">No files match this view</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {activeFolder === 'all'
          ? 'Import a real local project, or clear the search and scope filters.'
          : 'Clear the folder selection or choose another folder.'}
      </p>
    </div>
  )
}

function agentFileToDriveFile(file: AgentFile): DriveBrowserFile {
  return {
    id: file.path,
    name: file.name,
    path: file.path,
    directory: file.directory,
    scope: file.scope,
    revision: file.revision,
    local: file.local,
    kind: 'file',
    type: fileTypeForPath(file.path),
    size: formatBytes(file.size),
    modified: file.revision ? `rev ${file.revision}` : 'untracked',
    modifiedBy: file.scope === 'owner-private' ? 'Owner private' : 'HopIt agent',
    sharedWith: file.scope === 'owner-private' ? 1 : 2,
  }
}

function agentFoldersFromFiles(files: AgentFile[]): DriveFolder[] {
  const folders = Array.from(new Set(files.map((file) => file.directory)))
    .filter((directory) => directory !== '/')
    .sort()

  const rootFolder: DriveFolder = {
    id: 'workspace-root',
    name: 'Workspace root',
    directory: '/',
    kind: 'folder',
    modified: 'live',
    modifiedBy: 'HopIt agent',
    sharedWith: files.filter((file) => file.directory === '/').length,
    color: 'hop',
  }

  return [
    rootFolder,
    ...folders.map((directory) => ({
      id: directory,
      name: directory,
      directory,
      kind: 'folder' as const,
      modified: 'live',
      modifiedBy: 'HopIt agent',
      sharedWith: files.filter((file) => file.directory === directory).length,
      color: directory.startsWith('.private') ? 'amber' : 'grape',
    })),
  ]
}

function filterAgentFiles(
  files: AgentFile[],
  activeFolder: string,
  scopeFilter: DriveScopeFilter,
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase()

  return files.filter((file) => {
    if (activeFolder !== 'all' && file.directory !== activeFolder) return false
    if (scopeFilter === 'shared' && file.scope !== 'shared') return false
    if (scopeFilter === 'private' && file.scope !== 'owner-private') return false
    if (!normalizedQuery) return true
    return `${file.path} ${file.name} ${file.directory}`.toLowerCase().includes(normalizedQuery)
  })
}

function fileTypeForPath(filePath: string): DriveFile['type'] {
  if (filePath.endsWith('.md')) return 'doc'
  if (filePath.endsWith('.json')) return 'code'
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'code'
  return 'doc'
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function FileGrid({
  files,
  selectedPath,
  onSelect,
}: {
  files: DriveBrowserFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {files.map((f, i) => {
        const Icon = f.type ? fileTypeIconMap[f.type] : fileTypeIconMap.doc
        const color = f.type ? fileTypeColorMap[f.type] : '#3b82f6'
        return (
          <motion.button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.path)}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.03, duration: 0.3 }}
            className={cn(
              'group relative flex flex-col gap-2 rounded-xl border bg-card p-4.5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md',
              selectedPath === f.path ? 'border-primary/55 ring-2 ring-primary/10' : 'border-border',
            )}
          >
            <div className="flex items-center justify-between">
              <div
                className="flex size-9 items-center justify-center rounded-lg shadow-sm"
                style={{ background: `${color}15`, color }}
              >
                <Icon className="size-4.5" />
              </div>
            </div>
            <div className="min-w-0 mt-1">
              <p className="truncate text-xs font-semibold text-foreground" title={f.path}>
                {f.name}
              </p>
              <p className="mt-0.5 text-[10px] font-medium text-muted-foreground">
                {f.size} · {f.modified}
              </p>
              <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">
                {f.directory}
              </p>
            </div>
            <div className="mt-auto flex items-center justify-between pt-1">
              <div className="flex items-center gap-1">
                <ScopePill scope={f.scope} />
                <LocalStatePill local={f.local} />
              </div>
              <span
                title="Select this file to edit it."
                className="rounded-lg p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                aria-label="File actions"
              >
                <MoreHorizontal className="size-3.5" />
              </span>
            </div>
          </motion.button>
        )
      })}
    </div>
  )
}

function FileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: DriveBrowserFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  return (
    <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/80 shadow-sm">
      <li className="grid grid-cols-12 gap-2 bg-secondary/35 px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50">
        <span className="col-span-5">Name</span>
        <span className="col-span-3 hidden md:block">Directory</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-7 text-right sm:col-span-5 md:col-span-2">State</span>
      </li>
      {files.map((f) => {
        const Icon = f.type ? fileTypeIconMap[f.type] : fileTypeIconMap.doc
        const color = f.type ? fileTypeColorMap[f.type] : '#3b82f6'
        return (
          <li
            key={f.id}
            className={cn(
              'group grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-xs transition duration-150 hover:bg-primary/5 hover:text-primary',
              selectedPath === f.path && 'bg-primary/8',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(f.path)}
              className="col-span-5 flex min-w-0 items-center gap-2 text-left"
            >
              <Icon className="size-3.5 shrink-0" style={{ color }} />
              <span className="truncate font-medium text-foreground group-hover:text-primary" title={f.path}>{f.name}</span>
            </button>
            <span className="col-span-3 hidden truncate font-mono text-[10.5px] text-muted-foreground md:block">{f.directory}</span>
            <span className="col-span-2 hidden text-muted-foreground sm:block">{f.size}</span>
            <span className="col-span-7 flex justify-end gap-1 sm:col-span-5 md:col-span-2">
              <ScopePill scope={f.scope} />
              <LocalStatePill local={f.local} />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function FileEditor({
  file,
  draft,
  saving,
  loading,
  canEdit,
  cacheActionRunning,
  cacheActionsDisabled,
  onDraftChange,
  onSave,
  onHydrate,
  onPrune,
  onPin,
  onUnpin,
}: {
  file: AgentFile | null
  draft: string
  saving: boolean
  loading: boolean
  canEdit: boolean
  cacheActionRunning: boolean
  cacheActionsDisabled: boolean
  onDraftChange: (value: string) => void
  onSave: () => void
  onHydrate: () => void
  onPrune: () => void
  onPin: () => void
  onUnpin: () => void
}) {
  if (!file) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
        Select a text file to view or edit it.
      </div>
    )
  }

  const canHydrate = file.local.state === 'cloud-only' || !file.local.hydrated
  const canPrune = file.local.hydrated && file.local.prunable && !file.local.pinned
  const cacheDisabled = cacheActionsDisabled || cacheActionRunning

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border/80 bg-card">
      <div className="flex flex-col gap-2 border-b border-border/60 bg-secondary/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-foreground">{file.path}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] text-muted-foreground">
              {file.encoding ?? file.kind} · rev {file.revision ?? 'new'} · {file.scope}
            </span>
            <LocalStatePill local={file.local} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canHydrate || cacheDisabled}
            onClick={onHydrate}
            title="Hydrate this cloud file into the local workspace."
            className="gap-1.5 rounded-md"
          >
            <CloudDownload className="size-3.5" />
            Hydrate
          </Button>
          {file.local.pinned ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={cacheDisabled}
              onClick={onUnpin}
              title="Allow this file to be pruned from local cache."
              className="gap-1.5 rounded-md"
            >
              <PinOff className="size-3.5" />
              Unpin
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={cacheDisabled}
              onClick={onPin}
              title="Keep this file hydrated locally."
              className="gap-1.5 rounded-md"
            >
              <Pin className="size-3.5" />
              Keep
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canPrune || cacheDisabled}
            onClick={onPrune}
            title="Remove this clean cached body locally while keeping it in HopIt cloud."
            className="gap-1.5 rounded-md"
          >
            <Trash2 className="size-3.5" />
            Free
          </Button>
          <Button
            size="sm"
            disabled={!canEdit || saving || loading}
            onClick={onSave}
            className="gap-1.5 rounded-md"
          >
            <Save className="size-3.5" />
            {saving ? 'Saving' : 'Save'}
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="p-4 text-sm text-muted-foreground">Loading full file contents...</div>
      ) : canEdit ? (
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          spellCheck={false}
          className="h-[360px] w-full resize-y bg-background p-4 font-mono text-xs leading-5 outline-none"
        />
      ) : (
        <div className="p-4 text-sm text-muted-foreground">
          This file is not editable in the browser view. Use a visible UTF-8 text file under 2,400 characters.
        </div>
      )}
    </div>
  )
}

function LocalStatePill({ local }: { local: AgentFile['local'] }) {
  const meta = localStateMeta(local)

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide ring-1 ring-inset',
        meta.className,
      )}
      title={meta.title}
    >
      {meta.label}
    </span>
  )
}

function localStateMeta(local: AgentFile['local']) {
  if (local.blocked || local.state === 'blocked') {
    return {
      label: 'blocked',
      title: 'A local journal problem is blocking this path.',
      className: 'bg-destructive/10 text-destructive ring-destructive/20',
    }
  }
  if (local.pending || local.state === 'pending-upload') {
    return {
      label: 'pending',
      title: 'This path has a pending local upload.',
      className: 'bg-hop-amber/10 text-hop-amber ring-hop-amber/25',
    }
  }
  if (local.dirty || local.state === 'dirty') {
    return {
      label: 'dirty',
      title: 'This path differs from the acknowledged local manifest.',
      className: 'bg-hop-amber/10 text-hop-amber ring-hop-amber/25',
    }
  }
  if (local.pinned || local.state === 'pinned') {
    return {
      label: 'pinned',
      title: 'This path is kept hydrated locally.',
      className: 'bg-grape/10 text-grape ring-grape/20',
    }
  }
  if (local.prunable || local.state === 'prunable') {
    return {
      label: 'local',
      title: 'This clean local body can be freed without deleting it from HopIt cloud.',
      className: 'bg-sky-500/10 text-sky-600 ring-sky-500/20',
    }
  }
  if (local.state === 'uploaded') {
    return {
      label: 'synced',
      title: 'This local body has been acknowledged by HopIt cloud.',
      className: 'bg-primary/10 text-primary ring-primary/20',
    }
  }
  if (local.hydrated || local.state === 'hydrated') {
    return {
      label: 'local',
      title: 'This file is hydrated in the local workspace.',
      className: 'bg-sky-500/10 text-sky-600 ring-sky-500/20',
    }
  }
  return {
    label: 'cloud',
    title: 'Only cloud metadata is local right now.',
    className: 'bg-muted text-muted-foreground ring-border',
  }
}

function ScopePill({ scope }: { scope: AgentFile['scope'] }) {
  const privateScope = scope === 'owner-private'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide ring-1 ring-inset',
        privateScope
          ? 'bg-hop-amber/10 text-hop-amber ring-hop-amber/20'
          : 'bg-primary/10 text-primary ring-primary/20',
      )}
    >
      {privateScope ? <Lock className="size-2.5" /> : <Share2 className="size-2.5" />}
      {privateScope ? 'private' : 'shared'}
    </span>
  )
}

function FolderGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  )
}
