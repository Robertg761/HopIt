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
  driveFiles,
  driveFolders,
  fileTypeColorMap,
  fileTypeIconMap,
  type DriveFile,
} from './data'
import { cn } from '@/lib/utils'

const folderColorMap: Record<string, string> = {
  hop: 'bg-hop/15 text-hop ring-hop/30',
  grape: 'bg-grape/15 text-grape ring-grape/30',
  amber: 'bg-amber-star/15 text-amber-star ring-amber-star/30',
  sky: 'bg-sky-500/15 text-sky-500 ring-sky-500/30',
}

export function DriveSection() {
  const [view, setView] = React.useState<'grid' | 'list'>('grid')
  return (
    <section className="flex flex-col rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Files</h2>
            <span className="rounded-full bg-grape/10 px-1.5 py-0.5 text-[10px] font-medium text-grape">
              184 files
            </span>
          </div>
          <nav
            aria-label="Files path"
            className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
          >
            <span>Workspace</span>
            <ChevronRight className="size-3" />
            <span className="font-medium text-foreground">Repository files</span>
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
            className="gap-1.5 rounded-lg bg-grape text-grape-foreground hover:bg-grape/90"
          >
            <CloudUpload className="size-3.5" />
            Upload
          </Button>
        </div>
      </div>

      {/* Folders */}
      <div className="px-4 pt-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Folders
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {driveFolders.map((f, i) => (
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
                  {f.sharedWith} shared
                </p>
              </div>
            </motion.button>
          ))}
        </div>
      </div>

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
        {view === 'grid' ? (
          <FileGrid files={driveFiles} />
        ) : (
          <FileList files={driveFiles} />
        )}
      </div>

      {/* Upload dropzone */}
      <div className="mx-4 mb-4 rounded-xl border border-dashed border-border/80 bg-muted/30 px-4 py-4 text-center transition hover:border-hop/50 hover:bg-hop/5">
        <CloudUpload className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Drop files here or{' '}
          <button className="font-medium text-hop hover:underline">browse</button>{' '}
          · up to 2 GB per file
        </p>
      </div>
    </section>
  )
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
