'use client'

import * as React from 'react'
import Link from 'next/link'
import { FolderGit2 } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace, type AgentCommand } from '@/components/workspace/workspace-provider'
import { cn } from '@/lib/utils'
import { repoPath } from '@/components/shell/repo-nav'
import { CompareExplorer } from '@/components/features/compare/compare-explorer'
import { TrailView } from '@/components/features/trail/trail-view'
import { ChangedFilesCard } from './changed-files'
import { DecisionsCard } from './decisions-card'
import { FileInspector } from './file-inspector'
import { filterReviewHistory, HistoryTimelineCard } from './history-timeline'
import { ConflictPanel, ReviewActions, ReviewMetaRow } from './review-header'
import { deriveChangedFiles, reviewLineFingerprint } from './review-shared'
import { ThreadPanel, type ThreadAnchor } from './thread-panel'
import { useReviewData } from './use-review-data'

export type ReviewPageMode = 'review' | 'compare' | 'history'

const MODE_COPY: Record<ReviewPageMode, { title: string; description: string }> = {
  review: {
    title: 'Pull request',
    description: 'Inspect the active change set, discuss lines, and record decisions.',
  },
  compare: {
    title: 'Compare',
    description: 'Active change set vs Main.',
  },
  history: {
    title: 'History',
    description: 'Review, merge, and sync activity for this repository.',
  },
}

export function ReviewPage({ mode, codebaseId }: { mode: ReviewPageMode; codebaseId?: string }) {
  const { status, loading, selectCodebase, runCommand, runningCommand, actorId } = useWorkspace()
  const { toast } = useToast()
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [selectedLine, setSelectedLine] = React.useState<number | null>(null)

  const appliedCodebaseRef = React.useRef(false)
  React.useEffect(() => {
    if (codebaseId && !appliedCodebaseRef.current) {
      appliedCodebaseRef.current = true
      selectCodebase(codebaseId)
    }
  }, [codebaseId, selectCodebase])

  const activeChangeSetId =
    status.activeChangeSetId === 'None' || status.activeChangeSetId.startsWith('No ')
      ? null
      : status.activeChangeSetId
  const review = useReviewData(status.codebaseId, activeChangeSetId, actorId)

  const changedFiles = React.useMemo(
    () => deriveChangedFiles(status.files, status.mainRevision),
    [status.files, status.mainRevision],
  )
  const selectedFile =
    changedFiles.find((entry) => entry.file.path === selectedPath)?.file ?? null
  const lineForFile = selectedFile ? selectedLine : null

  const threadCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const thread of review.threads) {
      counts.set(thread.filePath, (counts.get(thread.filePath) ?? 0) + 1)
    }
    return counts
  }, [review.threads])

  const fileThreads = React.useMemo(
    () => review.threads.filter((thread) => thread.filePath === selectedFile?.path),
    [review.threads, selectedFile?.path],
  )

  const canWrite = status.requester.permissions.includes('write')
  const canReview = status.requester.permissions.includes('review')

  const threadComposerDisabledReason = !status.codebaseId
    ? 'No codebase selected.'
    : !activeChangeSetId
      ? 'Open a change set to anchor review threads.'
      : !canWrite
        ? 'You need write access to start review threads.'
        : null
  const decisionComposerDisabledReason = !status.codebaseId
    ? 'No codebase selected.'
    : !activeChangeSetId
      ? 'Open a change set to record decisions.'
      : !canReview
        ? 'You need review access to record decisions.'
        : null
  const anchor: ThreadAnchor | null = selectedFile
    ? {
        filePath: selectedFile.path,
        lineNumber: lineForFile,
        baseRevision: status.mainRevision,
        headRevision: status.cloudRevision,
        lineFingerprint: reviewLineFingerprint(selectedFile, lineForFile),
      }
    : null

  const handleCommand = React.useCallback(
    async (command: AgentCommand) => {
      const result = await runCommand(command)
      if (result.ok) {
        toast({ title: result.label ?? `${command} complete`, description: result.summary })
      } else {
        toast({
          title: `${command} failed`,
          description: result.error?.message ?? result.stderr ?? 'The agent command failed.',
          variant: 'destructive',
        })
      }
    },
    [runCommand, toast],
  )

  const copy = MODE_COPY[mode]
  const activeId = codebaseId ?? status.codebaseId

  return (
    <PageScaffold
      title={copy.title}
      description={copy.description}
      actions={
        mode === 'review' ? (
          <ReviewActions status={status} runningCommand={runningCommand} onCommand={handleCommand} />
        ) : undefined
      }
    >
      {activeId ? <PullsSubnav codebaseId={activeId} mode={mode} /> : null}
      {loading ? (
        <ReviewPageSkeleton />
      ) : !status.codebaseId ? (
        <EmptyState
          icon={FolderGit2}
          title="No repository selected"
          description="Open a repository to review its active change set."
        />
      ) : mode === 'history' ? (
        <div className="space-y-6">
          <TrailView codebaseId={status.codebaseId} />
          <HistoryTimelineCard events={filterReviewHistory(status.events)} />
        </div>
      ) : mode === 'compare' ? (
        <CompareExplorer codebaseId={status.codebaseId} />
      ) : (
        <>
          <ReviewMetaRow status={status} />
          <ConflictPanel status={status} runningCommand={runningCommand} onCommand={handleCommand} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="space-y-6">
              <ChangedFilesCard
                changedFiles={changedFiles}
                loading={loading}
                selectedPath={selectedPath}
                threadCounts={threadCounts}
                onSelect={(path) => {
                  setSelectedPath(path)
                  setSelectedLine(null)
                }}
              />
            </div>
            <div className="space-y-6">
              <FileInspector
                file={selectedFile}
                selectedLine={lineForFile}
                onSelectLine={setSelectedLine}
              />
              <ThreadPanel
                anchor={anchor}
                threads={fileThreads}
                review={review}
                composerDisabledReason={threadComposerDisabledReason}
              />
            </div>
          </div>
          <DecisionsCard review={review} composerDisabledReason={decisionComposerDisabledReason} />
        </>
      )}
    </PageScaffold>
  )
}

function PullsSubnav({ codebaseId, mode }: { codebaseId: string; mode: ReviewPageMode }) {
  const items: Array<{ id: ReviewPageMode; label: string; href: string }> = [
    { id: 'review', label: 'Conversation', href: repoPath(codebaseId, 'pulls') },
    { id: 'compare', label: 'Compare', href: repoPath(codebaseId, 'compare') },
    { id: 'history', label: 'History', href: repoPath(codebaseId, 'history') },
  ]

  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-0">
      {items.map((item) => {
        const active = item.id === mode
        return (
          <Link
            key={item.id}
            href={item.href}
            className={cn(
              'border-b-2 px-3 py-1.5 text-sm font-medium',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}

function ReviewPageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-2/3" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
