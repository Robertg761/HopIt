'use client'

import * as React from 'react'
import { DownloadCloud, FilePlus2, FileText, Files, GitBranch } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { ImportGitDialog } from '@/components/features/codebases/codebase-dialogs'
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
  const {
    status,
    loading,
    selectedCodebaseId,
    refresh,
    codebases,
    codebasesLoading,
    runCommand,
    runningCommand,
  } = useWorkspace()
  const { toast } = useToast()
  const [query, setQuery] = React.useState('')
  const [scope, setScope] = React.useState<ScopeFilter>('all')
  const [locality, setLocality] = React.useState<LocalityFilter>('all')
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [newFileOpen, setNewFileOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)

  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const files = status.files
  const codebase = codebases.find((entry) => entry.id === codebaseId)
  const cloudFileCount = codebase?.fileCount ?? status.fileCount
  const hydrationState = (codebase?.hydrationState ?? status.workspaceHydrationState).toLowerCase()
  const showEmptyState = !loading && !codebasesLoading && files.length === 0
  const workspaceNotReady =
    showEmptyState &&
    cloudFileCount > 0 &&
    (status.state === 'offline' ||
      codebase?.attached === false ||
      ['cloud-only', 'metadata-only', 'partial', 'not_attached', 'needs-hydration', 'unavailable', 'unknown'].includes(
        hydrationState,
      ))
  const emptyRepository = showEmptyState && !workspaceNotReady
  const hydrating = runningCommand === 'hydrateWorkspace'

  const hydrateWorkspace = async () => {
    if (!codebaseId || !status.commandsAvailable || hydrating) return
    const result = await runCommand('hydrateWorkspace', { codebaseId })
    if (result.ok) {
      toast({ title: 'Workspace hydration started', description: result.summary ?? 'Files are being prepared locally.' })
    } else {
      toast({
        title: 'Workspace hydration failed',
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

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
      title="Code"
      description="Browse and edit files in the selected repository."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {workspaceNotReady ? (
            <Button
              onClick={() => void hydrateWorkspace()}
              disabled={!codebaseId || !status.commandsAvailable || hydrating}
              title={status.commandsAvailable ? undefined : 'Available from the local agent'}
            >
              {hydrating ? <Spinner className="size-3.5" /> : <DownloadCloud />}
              Hydrate workspace
            </Button>
          ) : (
            <Button
              onClick={() => setNewFileOpen(true)}
              disabled={!codebaseId}
              title={codebaseId ? undefined : 'Select a codebase first'}
            >
              <FilePlus2 /> {emptyRepository ? 'Create first file' : 'New file'}
            </Button>
          )}
          {emptyRepository ? (
            <Button variant="outline" onClick={() => setImportOpen(true)} disabled={!status.commandsAvailable}>
              <GitBranch /> Import from Git
            </Button>
          ) : null}
        </div>
      }
    >
      {loading || codebasesLoading ? (
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
          title={workspaceNotReady ? "Files aren't available on this device yet" : 'No files yet'}
          description={
            workspaceNotReady
              ? 'The repository has cloud files, but this device has not prepared its local workspace yet.'
              : 'Create the first file or import a repository. HopIt keeps it synced across your devices.'
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {workspaceNotReady ? (
                <Button
                  onClick={() => void hydrateWorkspace()}
                  disabled={!codebaseId || !status.commandsAvailable || hydrating}
                  title={status.commandsAvailable ? undefined : 'Available from the local agent'}
                >
                  {hydrating ? <Spinner className="size-3.5" /> : <DownloadCloud />}
                  Hydrate workspace
                </Button>
              ) : (
                <>
                  <Button onClick={() => setNewFileOpen(true)} disabled={!codebaseId}>
                    <FilePlus2 /> Create first file
                  </Button>
                  <Button variant="outline" onClick={() => setImportOpen(true)} disabled={!status.commandsAvailable}>
                    <GitBranch /> Import from Git
                  </Button>
                </>
              )}
            </div>
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
      <ImportGitDialog open={importOpen} onOpenChange={setImportOpen} />
    </PageScaffold>
  )
}
