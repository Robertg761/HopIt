'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  CloudUpload,
  Grid3x3,
  List,
  MoreHorizontal,
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
import type { AgentFile, AgentStatusSnapshot } from '@/lib/agent-status'

const folderColorMap: Record<string, string> = {
  hop: 'bg-hop/15 text-hop ring-hop/30',
  grape: 'bg-grape/15 text-grape ring-grape/30',
  amber: 'bg-hop-amber/15 text-hop-amber ring-hop-amber/30',
  sky: 'bg-sky-500/15 text-sky-500 ring-sky-500/30',
}

type DriveSectionProps = {
  status: AgentStatusSnapshot
}

export function DriveSection({ status }: DriveSectionProps) {
  const [view, setView] = React.useState<'grid' | 'list'>('grid')
  const liveFiles = status.files.map(agentFileToDriveFile)
  const liveFolders = status.files.length > 0 ? agentFoldersFromFiles(status.files) : []
  const fileCountLabel = `${status.files.length} files`

  return (
    <section className="flex flex-col rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Files</h2>
            <span className="rounded-full bg-grape/10 px-1.5 py-0.5 text-[10px] font-medium text-grape">
              {fileCountLabel}
            </span>
          </div>
          <nav
            aria-label="Files path"
            className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
          >
            <span>Workspace</span>
            <ChevronRight className="size-3" />
            <span className="font-medium text-foreground">{status.codebaseName}</span>
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-border/60 bg-muted/50 p-0.5">
            <button
              onClick={() => setView('grid')}
              className={cn(
                'rounded-md p-1.5 transition',
                view === 'grid' ? 'bg-card shadow-sm' : 'text-muted-foreground',
              )}
              aria-label="Grid view"
            >
              <Grid3x3 className="size-3.5" />
            </button>
            <button
              onClick={() => setView('list')}
              className={cn(
                'rounded-md p-1.5 transition',
                view === 'list' ? 'bg-card shadow-sm' : 'text-muted-foreground',
              )}
              aria-label="List view"
            >
              <List className="size-3.5" />
            </button>
          </div>
          <Button
            size="sm"
            disabled
            className="gap-1.5 rounded-lg bg-grape text-grape-foreground hover:bg-grape/90"
          >
            <CloudUpload className="size-3.5" />
            Import
          </Button>
        </div>
      </div>

      {/* Folders */}
      {liveFolders.length > 0 ? (
        <div className="px-4 pt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Folders
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {liveFolders.map((f, i) => (
              <motion.button
                key={f.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.3 }}
                className="group flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/40 p-3 text-left transition hover:border-grape/40 hover:bg-grape/5"
              >
                <div
                  className={cn(
                    'flex size-9 items-center justify-center rounded-lg ring-1',
                    folderColorMap[f.color ?? 'hop'],
                  )}
                >
                  <FolderGlyph />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{f.name}</p>
                  <p className="text-[10.5px] text-muted-foreground">
                    <Users className="mr-1 inline size-2.5" />
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
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Files
          </p>
          <button className="text-[11px] text-muted-foreground hover:text-foreground">
            Sort: Modified ↓
          </button>
        </div>
        {liveFiles.length === 0 ? (
          <EmptyFiles />
        ) : view === 'grid' ? (
          <FileGrid files={liveFiles} />
        ) : (
          <FileList files={liveFiles} />
        )}
      </div>
    </section>
  )
}

function EmptyFiles() {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-6 text-center">
      <p className="text-sm font-medium">No files loaded</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Import a real local project, then this panel will show the files in the managed workspace.
      </p>
    </div>
  )
}

function agentFileToDriveFile(file: AgentFile): DriveFile {
  return {
    id: file.path,
    name: file.path,
    kind: 'file',
    type: fileTypeForPath(file.path),
    size: formatBytes(file.size),
    modified: file.revision ? `rev ${file.revision}` : 'untracked',
    modifiedBy: file.scope === 'owner-private' ? 'Owner private' : 'HopIt agent',
    sharedWith: file.scope === 'owner-private' ? 1 : 2,
  }
}

function agentFoldersFromFiles(files: AgentFile[]): DriveFile[] {
  const folders = Array.from(new Set(files.map((file) => file.directory)))
    .filter((directory) => directory !== '/')
    .sort()

  const rootFolder: DriveFile = {
    id: 'workspace-root',
    name: 'Workspace root',
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
      kind: 'folder' as const,
      modified: 'live',
      modifiedBy: 'HopIt agent',
      sharedWith: files.filter((file) => file.directory === directory).length,
      color: directory.startsWith('.private') ? 'amber' : 'grape',
    })),
  ]
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

function FileGrid({ files }: { files: DriveFile[] }) {
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
            className="group relative flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 transition hover:-translate-y-0.5 hover:border-grape/30 hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <div
                className="flex size-9 items-center justify-center rounded-lg"
                style={{ background: `${color}15`, color }}
              >
                <Icon className="size-4.5" />
              </div>
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium" title={f.name}>
                {f.name}
              </p>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                {f.size} · {f.modified}
              </p>
            </div>
            <div className="mt-auto flex items-center justify-between pt-1">
              <div className="flex items-center gap-1">
                <ShareStack count={f.sharedWith} />
              </div>
              <button
                className="rounded-md p-1 text-muted-foreground/60 opacity-0 transition hover:bg-muted group-hover:opacity-100"
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

function FileList({ files }: { files: DriveFile[] }) {
  return (
    <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
      <li className="grid grid-cols-12 gap-2 bg-muted/40 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="col-span-6">Name</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-2 hidden md:block">Modified</span>
        <span className="col-span-2 text-right sm:col-span-2">Shared</span>
      </li>
      {files.map((f) => {
        const Icon = f.type ? fileTypeIconMap[f.type] : fileTypeIconMap.doc
        const color = f.type ? fileTypeColorMap[f.type] : '#3b82f6'
        return (
          <li
            key={f.id}
            className="group grid cursor-pointer grid-cols-12 items-center gap-2 px-3 py-2 text-xs transition hover:bg-muted/40"
          >
            <span className="col-span-6 flex items-center gap-2 min-w-0">
              <Icon className="size-3.5 shrink-0" style={{ color }} />
              <span className="truncate">{f.name}</span>
            </span>
            <span className="col-span-2 hidden text-muted-foreground sm:block">{f.size}</span>
            <span className="col-span-2 hidden text-muted-foreground md:block">{f.modified}</span>
            <span className="col-span-6 flex justify-end sm:col-span-2">
              <ShareStack count={f.sharedWith} />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function ShareStack({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1">
      <div className="flex -space-x-1.5">
        {[0, 1, 2].slice(0, Math.min(count, 3)).map((i) => (
          <span
            key={i}
            className="size-4 rounded-full ring-1 ring-card"
            style={{
              background: ['#10b981', '#8b5cf6', '#f59e0b'][i],
            }}
          />
        ))}
      </div>
      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
        <Share2 className="size-2.5" />
        {count}
      </span>
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
