'use client'

import * as React from 'react'
import { FilePlus2, FileText, Files } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { FileDetail } from './file-detail'
import { FileList } from './file-list'
import { NewFileDialog } from './new-file-dialog'

type ScopeFilter = 'all' | 'shared' | 'private'
type LocalityFilter = 'all' | 'local' | 'cloud'

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'shared', label: 'Shared' },
  { value: 'private', label: 'Private' },
] as const

const LOCALITY_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'local', label: 'Local' },
  { value: 'cloud', label: 'Cloud-only' },
] as const

export function FilesPage() {
  const { status, loading, selectedCodebaseId, refresh } = useWorkspace()
  const [query, setQuery] = React.useState('')
  const [scope, setScope] = React.useState<ScopeFilter>('all')
  const [locality, setLocality] = React.useState<LocalityFilter>('all')
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [newFileOpen, setNewFileOpen] = React.useState(false)

  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const files = status.files

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return files.filter((file) => {
      if (needle && !file.path.toLowerCase().includes(needle)) return false
      if (scope === 'shared' && file.scope !== 'shared') return false
      if (scope === 'private' && file.scope !== 'owner-private') return false
      if (locality === 'local' && file.local.state === 'cloud-only') return false
      if (locality === 'cloud' && file.local.state !== 'cloud-only') return false
      return true
    })
  }, [files, query, scope, locality])

  const selectedFile = React.useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  )

  return (
    <PageScaffold
      title="Files"
      description="Browse and edit the cloud files of the selected codebase."
      actions={
        <Button
          onClick={() => setNewFileOpen(true)}
          disabled={!codebaseId}
          title={codebaseId ? undefined : 'Select a codebase first'}
        >
          <FilePlus2 /> New file
        </Button>
      }
    >
      {loading && files.length === 0 ? (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-2 lg:col-span-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <Skeleton className="h-80 w-full lg:col-span-3" />
        </div>
      ) : files.length === 0 ? (
        <EmptyState
          icon={Files}
          title="No cloud files"
          description="This codebase has no visible cloud files yet. Attach or hydrate a workspace from the Codebases page to sync files here."
          action={
            <Button variant="outline" asChild>
              <a href="/codebases">Go to Codebases</a>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-3 lg:col-span-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by path…"
              aria-label="Filter files by path"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Segmented aria-label="Scope filter" value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
              <Segmented
                aria-label="Local state filter"
                value={locality}
                onChange={setLocality}
                options={LOCALITY_OPTIONS}
              />
            </div>
            <FileList files={filtered} selectedPath={selectedPath} onSelect={setSelectedPath} />
          </div>
          <div className="lg:col-span-3">
            {selectedFile ? (
              <FileDetail file={selectedFile} codebaseId={codebaseId} />
            ) : (
              <EmptyState
                icon={FileText}
                title="Select a file"
                description="Choose a file from the list to see its cloud state, local cache status, and contents."
                className="h-full min-h-64"
              />
            )}
          </div>
        </div>
      )}

      <NewFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        codebaseId={codebaseId}
        onCreated={(path) => {
          setSelectedPath(path)
          void refresh()
        }}
      />
    </PageScaffold>
  )
}
