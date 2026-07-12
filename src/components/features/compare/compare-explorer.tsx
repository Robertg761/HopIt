'use client'

import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  ChevronRight,
  FileDiff,
  FileQuestion,
  GitCompareArrows,
  Lock,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { humanizeApiError } from '@/lib/client/errors'
import {
  changedEntryCount,
  fileStateView,
  parseComparePairFromSearch,
  sortCompareEntries,
  summaryChips,
  unifiedDiffLines,
} from '@/lib/client/compare/mappers'
import type { CompareEntry, CompareError, CompareFileBody } from '@/lib/client/compare/types'
import { useCompareData, type LoadState, type FileDiffData } from './use-compare-data'

const BACKEND_UNAVAILABLE_CODES = new Set(['d1_required', 'cloud_backend_unavailable', 'http_503'])

export function CompareExplorer({ codebaseId }: { codebaseId: string | null }) {
  // Deep-link support: a trail episode links here as `?from=&to=`. Read the pair
  // once on mount from the URL (no useSearchParams, so no Suspense boundary is
  // required for static export). Falls back to the default pair when absent.
  const [initialPair] = React.useState(() =>
    parseComparePairFromSearch(typeof window === 'undefined' ? '' : window.location.search),
  )
  const compare = useCompareData(codebaseId, initialPair)
  const { revisions, from, to, setFrom, setTo, swap, directory } = compare
  const [expanded, setExpanded] = React.useState<string | null>(null)

  // Collapse the open file whenever the compared pair changes.
  React.useEffect(() => {
    setExpanded(null)
  }, [from, to])

  if (!codebaseId) {
    return (
      <EmptyState
        icon={GitCompareArrows}
        title="No repository selected"
        description="Open a repository to compare two steps on its trail."
      />
    )
  }

  if (!revisions || revisions.status === 'loading') {
    return <ExplorerSkeleton />
  }

  if (revisions.status === 'error') {
    return <StateNote error={revisions.error} icon={AlertTriangle} title="Trail history unavailable" />
  }

  const options = revisions.data.options
  if (options.length === 0) {
    return (
      <EmptyState
        icon={GitCompareArrows}
        title="No retained trail steps yet"
        description="Once this repository records object-backed trail steps, you can compare any two of them here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Compare trail steps</CardTitle>
          <CardDescription>
            Pick two steps on this repository&rsquo;s trail to see what changed between them.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <RevisionPicker
              label="From step"
              value={from}
              options={options}
              onChange={setFrom}
            />
            <button
              type="button"
              onClick={swap}
              className="mb-0.5 flex size-10 items-center justify-center rounded-xl border border-input text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none"
              aria-label="Swap from and to steps"
              title="Swap steps"
            >
              <ArrowLeftRight className="size-4" />
            </button>
            <RevisionPicker label="To step" value={to} options={options} onChange={setTo} />
            <div className="mb-2 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              step {from}
              <ArrowRight aria-hidden className="size-3.5" />
              step {to}
            </div>
          </div>
          <SummaryRow directory={directory} />
        </CardContent>
      </Card>

      <FileListCard
        directory={directory}
        expanded={expanded}
        onToggle={(path) => {
          setExpanded((current) => (current === path ? null : path))
          if (path) compare.loadFileDiff(path)
        }}
        fileDiff={compare.fileDiff}
      />
    </div>
  )
}

function RevisionPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: number | null
  options: number[]
  onChange: (value: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select
        className="w-40"
        value={value ?? ''}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            step {option}
          </option>
        ))}
      </Select>
    </label>
  )
}

function SummaryRow({ directory }: { directory: LoadState<import('./use-compare-data').DirectoryData> | null }) {
  if (!directory) return null
  if (directory.status === 'loading') {
    return (
      <div className="mt-4 flex gap-2 border-t border-border pt-4">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
    )
  }
  if (directory.status === 'error') return null

  const chips = summaryChips(directory.data.summary)
  const changed = changedEntryCount(directory.data.entries)
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <Badge tone={changed > 0 ? 'iris' : 'neutral'}>
        {changed} changed file{changed === 1 ? '' : 's'}
      </Badge>
      {chips.map((chip) => (
        <Badge key={chip.key} tone={chip.tone}>
          <span className="tabular-nums">{chip.value}</span>
          {chip.label}
        </Badge>
      ))}
    </div>
  )
}

function FileListCard({
  directory,
  expanded,
  onToggle,
  fileDiff,
}: {
  directory: LoadState<import('./use-compare-data').DirectoryData> | null
  expanded: string | null
  onToggle: (path: string) => void
  fileDiff: (path: string) => LoadState<FileDiffData> | undefined
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <CardDescription>Every path visible to you that differs between the two steps.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {!directory || directory.status === 'loading' ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : directory.status === 'error' ? (
          <StateNote
            error={directory.error}
            icon={AlertTriangle}
            title={
              directory.error.code === 'revision_expired'
                ? 'These steps are outside retained history'
                : 'Compare unavailable'
            }
          />
        ) : directory.data.entries.length === 0 ? (
          <EmptyState
            icon={FileDiff}
            title="Nothing to compare"
            description="No files visible to you differ between these two steps."
          />
        ) : (
          <ul className="divide-y divide-border">
            {sortCompareEntries(directory.data.entries).map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                open={expanded === entry.path}
                onToggle={() => onToggle(entry.path)}
                diff={fileDiff(entry.path)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function FileRow({
  entry,
  open,
  onToggle,
  diff,
}: {
  entry: CompareEntry
  open: boolean
  onToggle: () => void
  diff: LoadState<FileDiffData> | undefined
}) {
  const view = fileStateView(entry.state)
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 px-1 py-2.5 text-left outline-none transition-colors',
          'hover:bg-muted/40 focus-visible:bg-muted/40 rounded-lg',
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.path}>
          {entry.path}
        </span>
        {entry.privacyZone && entry.privacyZone !== 'shared' ? (
          <Badge tone="outline">{entry.privacyZone}</Badge>
        ) : null}
        <Badge tone={view.tone}>{view.label}</Badge>
      </button>
      {open ? (
        <div className="px-1 pb-3 pl-7">
          <p className="mb-2 text-xs text-muted-foreground">{view.description}</p>
          <DiffBody diff={diff} />
        </div>
      ) : null}
    </li>
  )
}

function DiffBody({ diff }: { diff: LoadState<FileDiffData> | undefined }) {
  if (!diff || diff.status === 'loading') {
    return <Skeleton className="h-16 w-full" />
  }
  if (diff.status === 'error') {
    return <StateNote error={diff.error} icon={AlertTriangle} title="Diff unavailable" inline />
  }
  const body = diff.data.entry.body
  if (!body) {
    return <QuietNote>No diff body was returned for this step.</QuietNote>
  }
  return <FileDiffBody body={body} />
}

function FileDiffBody({ body }: { body: CompareFileBody }) {
  switch (body.state) {
    case 'text_diff': {
      const lines = unifiedDiffLines(body.diff)
      if (!body.diff.changed || lines.length === 0) {
        return <QuietNote>These two steps hold identical content for this file.</QuietNote>
      }
      return (
        <div className="overflow-x-auto rounded-lg border border-border bg-muted/30">
          <table className="w-full border-collapse font-mono text-xs">
            <tbody>
              {lines.map((line, index) => (
                <tr
                  key={index}
                  className={cn(
                    line.type === 'add' && 'bg-hop-soft/40',
                    line.type === 'remove' && 'bg-danger-soft/40',
                    line.type === 'context' && 'text-muted-foreground',
                  )}
                >
                  <td className="w-10 select-none px-2 py-0.5 text-right text-muted-foreground/70">
                    {line.oldLineNumber ?? ''}
                  </td>
                  <td className="w-10 select-none px-2 py-0.5 text-right text-muted-foreground/70">
                    {line.newLineNumber ?? ''}
                  </td>
                  <td className="w-4 select-none px-1 py-0.5 text-muted-foreground/70">
                    {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
                  </td>
                  <td className="whitespace-pre-wrap break-all px-2 py-0.5">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'binary_unchanged':
      return <QuietNote>Binary file, identical at both steps.</QuietNote>
    case 'binary_changed':
      return (
        <NoteCard icon={FileQuestion} tone="iris">
          Binary file changed. HopIt shows binary changes by metadata only — no line-by-line diff.
        </NoteCard>
      )
    case 'requiresLocalKey':
      return (
        <NoteCard icon={Lock} tone="info">
          This file is encrypted on your device. Open this trail with the local agent, which holds the
          key, to see its diff. The server never sees the plaintext.
        </NoteCard>
      )
    case 'missing_blob':
      return (
        <NoteCard icon={AlertTriangle} tone="danger">
          The stored content for this step is missing, so its diff cannot be shown. This is reported
          honestly rather than reconstructed.
        </NoteCard>
      )
    case 'integrity_failure':
      return (
        <NoteCard icon={AlertTriangle} tone="danger">
          Stored content did not match its recorded hash, so it is withheld. The compare fails closed
          for this file rather than showing content it cannot trust.
        </NoteCard>
      )
    case 'metadata_only':
      return <QuietNote>This entry is a {body.reason}; there is no text diff to show.</QuietNote>
    default:
      return <QuietNote>No diff is available for this file.</QuietNote>
  }
}

function NoteCard({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof Lock
  tone: 'info' | 'danger' | 'iris'
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger-soft bg-danger-soft/20 text-danger-soft-foreground'
      : tone === 'info'
        ? 'border-info-soft bg-info-soft/20 text-info-soft-foreground'
        : 'border-iris-soft bg-iris-soft/20 text-iris-soft-foreground'
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', toneClass)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function StateNote({
  error,
  icon: Icon,
  title,
  inline,
}: {
  error: CompareError
  icon: typeof AlertTriangle
  title: string
  inline?: boolean
}) {
  const message = BACKEND_UNAVAILABLE_CODES.has(error.code)
    ? 'The hosted trail history backend is not available in this environment.'
    : humanizeApiError(error.message)
  if (inline) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>{message}</span>
      </div>
    )
  }
  return <EmptyState icon={Icon} title={title} description={message} />
}

function QuietNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

function ExplorerSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
