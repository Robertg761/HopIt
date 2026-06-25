'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  CloudUpload,
  Grid3x3,
  List,
  Lock,
  MoreHorizontal,
  Search,
  Share2,
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

const folderColorMap: Record<string, string> = {
  hop: 'bg-primary/10 text-primary border border-primary/20',
  grape: 'bg-grape/10 text-grape border border-grape/20',
  amber: 'bg-hop-amber/10 text-hop-amber border border-hop-amber/20',
  sky: 'bg-sky-500/10 text-sky-500 border border-sky-500/20',
}

type DriveSectionProps = {
  status: AgentStatusSnapshot
}

type DriveScopeFilter = 'all' | 'shared' | 'private'

type DriveBrowserFile = DriveFile & {
  path: string
  directory: string
  scope: AgentFile['scope']
  revision: number | null
}

type DriveFolder = DriveFile & {
  directory: string
}

export function DriveSection({ status }: DriveSectionProps) {
  const [view, setView] = React.useState<'grid' | 'list'>('grid')
  const [activeFolder, setActiveFolder] = React.useState('all')
  const [scopeFilter, setScopeFilter] = React.useState<DriveScopeFilter>('all')
  const [fileQuery, setFileQuery] = React.useState('')
  const filteredAgentFiles = React.useMemo(
    () => filterAgentFiles(status.files, activeFolder, scopeFilter, fileQuery),
    [activeFolder, fileQuery, scopeFilter, status.files],
  )
  const liveFiles = filteredAgentFiles.map(agentFileToDriveFile)
  const liveFolders = status.files.length > 0 ? agentFoldersFromFiles(status.files) : []
  const fileCountLabel = `${status.files.length} files`
  const privateFileCount = status.files.filter((file) => file.scope === 'owner-private').length
  const sharedFileCount = status.files.length - privateFileCount

  return (
    <section className="panel-surface flex flex-col rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-foreground">Files</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
              {fileCountLabel}
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
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Files
          </p>
          <span className="text-[10.5px] font-semibold text-muted-foreground">{liveFiles.length} visible</span>
        </div>
        {liveFiles.length === 0 ? (
          <EmptyFiles activeFolder={activeFolder} />
        ) : view === 'grid' ? (
          <FileGrid files={liveFiles} />
        ) : (
          <FileList files={liveFiles} />
        )}
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

function FileGrid({ files }: { files: DriveBrowserFile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {files.map((f, i) => {
        const Icon = f.type ? fileTypeIconMap[f.type] : fileTypeIconMap.doc
        const color = f.type ? fileTypeColorMap[f.type] : '#3b82f6'
        return (
          <motion.article
            key={f.id}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.03, duration: 0.3 }}
            className="group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4.5 transition duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
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
              </div>
              <button
                disabled
                title="File actions are not available in this view yet."
                className="rounded-lg p-1 text-muted-foreground opacity-0 transition disabled:cursor-not-allowed group-hover:opacity-100"
                aria-label="File actions"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </div>
          </motion.article>
        )
      })}
    </div>
  )
}

function FileList({ files }: { files: DriveBrowserFile[] }) {
  return (
    <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/80 shadow-sm">
      <li className="grid grid-cols-12 gap-2 bg-secondary/35 px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/50">
        <span className="col-span-5">Name</span>
        <span className="col-span-3 hidden md:block">Directory</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-7 text-right sm:col-span-5 md:col-span-2">Scope</span>
      </li>
      {files.map((f) => {
        const Icon = f.type ? fileTypeIconMap[f.type] : fileTypeIconMap.doc
        const color = f.type ? fileTypeColorMap[f.type] : '#3b82f6'
        return (
          <li
            key={f.id}
            className="group grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-xs transition duration-150 hover:bg-primary/5 hover:text-primary"
          >
            <span className="col-span-5 flex min-w-0 items-center gap-2">
              <Icon className="size-3.5 shrink-0" style={{ color }} />
              <span className="truncate font-medium text-foreground group-hover:text-primary" title={f.path}>{f.name}</span>
            </span>
            <span className="col-span-3 hidden truncate font-mono text-[10.5px] text-muted-foreground md:block">{f.directory}</span>
            <span className="col-span-2 hidden text-muted-foreground sm:block">{f.size}</span>
            <span className="col-span-7 flex justify-end sm:col-span-5 md:col-span-2">
              <ScopePill scope={f.scope} />
            </span>
          </li>
        )
      })}
    </ul>
  )
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
