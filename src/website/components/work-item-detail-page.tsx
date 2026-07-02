'use client'

import * as React from 'react'
import {
  ArrowLeft,
  CircleDot,
  Columns3,
  Loader2,
  MessageSquareText,
  PackageCheck,
  RefreshCcw,
  Rocket,
  Tag,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  fetchWorkItems,
  type CollaborationDiscussion,
  type CollaborationIssue,
  type CollaborationProject,
  type CollaborationRelease,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import { cn } from '@/lib/utils'
import { useAgentStatus } from '@/website/hooks/use-agent-status'

type WorkItemDetailPageProps = {
  codebaseId: string
  kind: string
  itemId: string
}

type WorkItemKind = 'issues' | 'discussions' | 'releases' | 'projects'

export function WorkItemDetailPage({ codebaseId, kind, itemId }: WorkItemDetailPageProps) {
  const normalizedKind = normalizeKind(kind)
  const agentStatus = useAgentStatus(codebaseId)
  const [workItems, setWorkItems] = React.useState<WorkItemsResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const loadWorkItems = React.useCallback(async () => {
    if (!normalizedKind) return
    setLoading(true)
    setMessage(null)
    try {
      const result = await fetchWorkItems(codebaseId)
      setWorkItems(result)
      if (!result.ok) setMessage(result.error?.message ?? 'Work item failed to load.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Work item failed to load.')
    } finally {
      setLoading(false)
    }
  }, [codebaseId, normalizedKind])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkItems()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [loadWorkItems])

  const item = React.useMemo(
    () => normalizedKind && workItems ? findWorkItem(workItems, normalizedKind, itemId) : null,
    [itemId, normalizedKind, workItems],
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-3 py-4 sm:px-4 lg:px-6 lg:py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <a
            href="/work-items"
            className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Work items
          </a>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || !normalizedKind}
            className="h-9 w-fit rounded-lg text-xs"
            onClick={() => void loadWorkItems()}
          >
            <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        <section className="panel-surface overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border/60 p-5">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                {normalizedKind ? <KindIcon kind={normalizedKind} /> : <PackageCheck className="size-5" />}
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase text-primary">
                  {normalizedKind ? kindLabel(normalizedKind) : 'Unknown work item'}
                </p>
                <h1 className="mt-1 text-2xl font-bold leading-tight">
                  {item && normalizedKind ? itemTitle(normalizedKind, item) : 'Work item detail'}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {codebaseId} - {decodeURIComponent(itemId)}
                </p>
              </div>
            </div>
          </div>

          {loading || agentStatus.loading ? (
            <StateNotice icon={Loader2} title="Loading work item" detail="Reading codebase state and collaboration data." spinning />
          ) : !normalizedKind ? (
            <StateNotice icon={PackageCheck} title="Unsupported work item type" detail="Use issues, discussions, releases, or projects." />
          ) : message ? (
            <StateNotice icon={PackageCheck} title="Work item unavailable" detail={message} />
          ) : !item ? (
            <StateNotice icon={PackageCheck} title="Work item not found" detail="The item may have been removed or belongs to a different codebase." />
          ) : normalizedKind === 'issues' ? (
            <IssueDetail issue={item as CollaborationIssue} />
          ) : normalizedKind === 'discussions' ? (
            <DiscussionDetail discussion={item as CollaborationDiscussion} />
          ) : normalizedKind === 'releases' ? (
            <ReleaseDetail release={item as CollaborationRelease} />
          ) : (
            <ProjectDetail project={item as CollaborationProject} />
          )}
        </section>
      </main>
    </div>
  )
}

function IssueDetail({ issue }: { issue: CollaborationIssue }) {
  return (
    <DetailBody>
      <MetaGrid
        items={[
          ['Number', `#${issue.number}`],
          ['Status', issue.status],
          ['Priority', issue.priority ?? 'none'],
          ['Updated', formatDate(issue.updatedAt)],
          ['Change set', issue.linkedChangeSetId ?? 'none'],
          ['Release', issue.linkedReleaseId ?? 'none'],
        ]}
      />
      <RichText title="Body" value={issue.body ?? 'No issue body.'} />
      <LabelRow labels={issue.labels} />
      <Comments comments={issue.comments} />
    </DetailBody>
  )
}

function DiscussionDetail({ discussion }: { discussion: CollaborationDiscussion }) {
  return (
    <DetailBody>
      <MetaGrid
        items={[
          ['Number', `#${discussion.number}`],
          ['Status', discussion.status],
          ['Category', discussion.category],
          ['Updated', formatDate(discussion.updatedAt)],
          ['Change set', discussion.linkedChangeSetId ?? 'none'],
          ['Linked issues', discussion.linkedIssueIds.length.toString()],
        ]}
      />
      <RichText title="Discussion" value={discussion.body} />
      <LabelRow labels={discussion.labels} />
      <Comments comments={discussion.comments} />
    </DetailBody>
  )
}

function ReleaseDetail({ release }: { release: CollaborationRelease }) {
  return (
    <DetailBody>
      <MetaGrid
        items={[
          ['Number', `#${release.number}`],
          ['Status', release.status],
          ['Version', release.version],
          ['Target', `${release.target.type} ${release.target.id}`],
          ['Revision', release.target.revision?.toString() ?? 'none'],
          ['Published', release.publishedAt ? formatDate(release.publishedAt) : 'not published'],
        ]}
      />
      <RichText title="Notes" value={release.notes} />
      <section>
        <h2 className="text-sm font-semibold">Assets</h2>
        {release.assets.length > 0 ? (
          <ol className="mt-2 grid gap-2 md:grid-cols-2">
            {release.assets.map((asset) => (
              <li key={asset.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="text-sm font-semibold">{asset.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {asset.kind}{asset.size !== null ? ` - ${formatBytes(asset.size)}` : ''}
                </p>
                {asset.checksum ? <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{asset.checksum}</p> : null}
                {asset.url ? (
                  <a href={asset.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs font-medium text-primary">
                    Open asset
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No assets attached.</p>
        )}
      </section>
    </DetailBody>
  )
}

function ProjectDetail({ project }: { project: CollaborationProject }) {
  return (
    <DetailBody>
      <MetaGrid
        items={[
          ['Number', `#${project.number}`],
          ['Status', project.status],
          ['Cards', project.items.length.toString()],
          ['Updated', formatDate(project.updatedAt)],
          ['Archived', project.archivedAt ? formatDate(project.archivedAt) : 'not archived'],
        ]}
      />
      <RichText title="Description" value={project.description ?? 'No project description.'} />
      <section>
        <h2 className="text-sm font-semibold">Board</h2>
        <div className="mt-2 grid gap-3 lg:grid-cols-3">
          {project.columns.map((column) => {
            const cards = project.items.filter((item) => item.columnId === column.id).sort((a, b) => a.position - b.position)
            return (
              <div key={column.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{column.name}</p>
                  <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/50">{cards.length}</span>
                </div>
                {cards.length > 0 ? (
                  <ol className="mt-2 space-y-2">
                    {cards.map((card) => (
                      <li key={card.id} className="rounded-md bg-card p-2 ring-1 ring-border/50">
                        <p className="line-clamp-2 text-xs font-semibold">{card.item.title ?? card.item.id ?? 'Untitled card'}</p>
                        {card.item.body ? <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{card.item.body}</p> : null}
                        <p className="mt-1 text-[10px] text-muted-foreground">{card.item.type ?? 'note'} - {formatDate(card.updatedAt)}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No cards.</p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </DetailBody>
  )
}

function DetailBody({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 p-5">{children}</div>
}

function MetaGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <dt className="text-[10px] font-bold uppercase text-muted-foreground">{label}</dt>
          <dd className="mt-1 truncate text-sm font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function RichText({ title, value }: { title: string; value: string }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
        {value}
      </p>
    </section>
  )
}

function LabelRow({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span key={label} className="inline-flex items-center gap-1 rounded-md bg-grape/10 px-1.5 py-0.5 text-[10px] text-grape">
          <Tag className="size-2.5" />
          {label}
        </span>
      ))}
    </div>
  )
}

function Comments({
  comments,
}: {
  comments: Array<{ id: string; body: string; createdBy: string; createdAt: string }>
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Comments</h2>
      {comments.length > 0 ? (
        <ol className="mt-2 space-y-2">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
              <p className="mt-2 text-[10px] text-muted-foreground">{comment.createdBy} - {formatDate(comment.createdAt)}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No comments yet.</p>
      )}
    </section>
  )
}

function StateNotice({
  icon: Icon,
  title,
  detail,
  spinning = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string
  spinning?: boolean
}) {
  return (
    <div className="p-8 text-center">
      <Icon className={cn('mx-auto size-5 text-muted-foreground', spinning && 'animate-spin')} />
      <p className="mt-2 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function KindIcon({ kind }: { kind: WorkItemKind }) {
  if (kind === 'issues') return <CircleDot className="size-5" />
  if (kind === 'discussions') return <MessageSquareText className="size-5" />
  if (kind === 'projects') return <Columns3 className="size-5" />
  return <Rocket className="size-5" />
}

function normalizeKind(value: string): WorkItemKind | null {
  if (value === 'issues' || value === 'discussions' || value === 'releases' || value === 'projects') return value
  return null
}

function findWorkItem(workItems: WorkItemsResponse, kind: WorkItemKind, itemId: string) {
  const decoded = decodeURIComponent(itemId)
  const matches = (item: { id: string; number: number }) => item.id === decoded || item.number.toString() === decoded
  if (kind === 'issues') return workItems.issues.find(matches) ?? null
  if (kind === 'discussions') return workItems.discussions.find(matches) ?? null
  if (kind === 'releases') return workItems.releases.find(matches) ?? null
  return workItems.projects.find(matches) ?? null
}

function itemTitle(kind: WorkItemKind, item: CollaborationIssue | CollaborationDiscussion | CollaborationRelease | CollaborationProject) {
  if (kind === 'releases') {
    const release = item as CollaborationRelease
    return `${release.version}: ${release.title}`
  }
  if (kind === 'projects') return (item as CollaborationProject).name
  return (item as CollaborationIssue | CollaborationDiscussion).title
}

function kindLabel(kind: WorkItemKind) {
  if (kind === 'issues') return 'Issue'
  if (kind === 'discussions') return 'Discussion'
  if (kind === 'releases') return 'Release'
  return 'Project'
}

function formatDate(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
