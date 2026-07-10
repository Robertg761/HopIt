'use client'

import * as React from 'react'
import { AlertTriangle, FolderGit2, GitBranch, Plus } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace, type CodebaseSummary } from '@/components/workspace/workspace-provider'
import { CodebaseRow } from './codebase-row'
import {
  DeleteCodebaseDialog,
  ImportGitDialog,
  NewCodebaseDialog,
  RenameCodebaseDialog,
} from './codebase-dialogs'
import { humanizeMessage } from './codebases-api'

export function CodebasesPage() {
  const { codebases, codebasesLoading, codebasesError, status } = useWorkspace()
  const [newOpen, setNewOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [renameTarget, setRenameTarget] = React.useState<CodebaseSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<CodebaseSummary | null>(null)

  const commandsAvailable = status.commandsAvailable
  const importHint = commandsAvailable ? undefined : 'Available from the local agent'
  const showEmpty = !codebasesLoading && codebases.length === 0

  return (
    <PageScaffold
      title="Repositories"
      description="Cloud repositories for this account."
      actions={
        <>
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            disabled={!commandsAvailable}
            title={importHint}
          >
            <GitBranch /> Import from Git
          </Button>
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> New repository
          </Button>
        </>
      }
    >
      {codebasesError ? (
        <div className="flex items-start gap-2 rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-soft-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{humanizeMessage(codebasesError)}</span>
        </div>
      ) : null}

      <section aria-label="Codebases">
        {codebasesLoading && codebases.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : showEmpty ? (
          <EmptyState
            icon={FolderGit2}
            title="No repositories yet"
            description="A repository lives in the cloud and stays synced across your devices. Create one or import from Git."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={() => setNewOpen(true)}>
                  <Plus /> New repository
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setImportOpen(true)}
                  disabled={!commandsAvailable}
                  title={importHint}
                >
                  <GitBranch /> Import from Git
                </Button>
              </div>
            }
          />
        ) : (
          <div className="rounded-md border border-border bg-card">
            <ul className="space-y-1">
              {codebases.map((codebase) => (
                <CodebaseRow
                  key={codebase.id}
                  codebase={codebase}
                  onRename={() => setRenameTarget(codebase)}
                  onDelete={() => setDeleteTarget(codebase)}
                />
              ))}
            </ul>
          </div>
        )}
      </section>

      <NewCodebaseDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportGitDialog open={importOpen} onOpenChange={setImportOpen} />
      <RenameCodebaseDialog codebase={renameTarget} onClose={() => setRenameTarget(null)} />
      <DeleteCodebaseDialog codebase={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </PageScaffold>
  )
}
