'use client'

import * as React from 'react'
import Link from 'next/link'
import { Paperclip, Rocket, Tag } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { updateCollaborationItem, type CollaborationRelease } from '@/lib/collaboration'
import { AddAssetDialog, NewReleaseDialog } from './release-dialogs'
import {
  ConfirmDialog,
  RELEASE_STATUS_TONE,
  RelativeTime,
  capabilityProps,
  workItemHref,
  type WorkTabProps,
} from './work-common'

type ReleaseFilter = 'draft' | 'published' | 'all'

const FILTER_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'all', label: 'All' },
] as const

export type ReleasesTabProps = WorkTabProps & {
  releaseTarget: CollaborationRelease['target'] | undefined
}

export function ReleasesTab({
  codebaseId,
  actorId,
  data,
  busyKey,
  runMutation,
  createOpen,
  onCreateOpenChange,
  releaseTarget,
}: ReleasesTabProps) {
  const [filter, setFilter] = React.useState<ReleaseFilter>('all')
  const [publishId, setPublishId] = React.useState<string | null>(null)
  const [assetReleaseId, setAssetReleaseId] = React.useState<string | null>(null)

  const filtered = React.useMemo(
    () =>
      data.releases
        .filter((release) => (filter === 'all' ? true : release.status === filter))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.releases, filter],
  )

  const publishDisabled = capabilityProps(data.capabilities.publishRelease)
  const assetDisabled = capabilityProps(data.capabilities.createReleaseAsset)
  const publishRelease = data.releases.find((release) => release.id === publishId) ?? null
  const assetRelease = data.releases.find((release) => release.id === assetReleaseId) ?? null

  return (
    <div className="space-y-4">
      <Segmented value={filter} onChange={setFilter} options={FILTER_OPTIONS} aria-label="Filter releases" />
      {filtered.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title={data.releases.length === 0 ? 'No releases yet' : 'No matching releases'}
          description={
            data.releases.length === 0
              ? 'Cut a versioned release when the codebase is ready to ship.'
              : 'Try a different status filter.'
          }
        />
      ) : (
        <Card className="p-2">
          <ul className="space-y-0.5">
            {filtered.map((release) => (
              <li key={release.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50">
                <Tag className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="shrink-0 font-mono text-xs text-foreground">{release.version}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={workItemHref(codebaseId, 'release', release.id)}
                      className="rounded-sm text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      {release.title}
                    </Link>
                    <Badge tone={RELEASE_STATUS_TONE[release.status]}>{release.status}</Badge>
                  </div>
                  {release.notes ? (
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{release.notes}</p>
                  ) : null}
                </div>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3.5" aria-hidden />
                  {release.assets.length}
                </span>
                <RelativeTime value={release.publishedAt ?? release.updatedAt} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={assetDisabled.disabled}
                  title={assetDisabled.title}
                  onClick={() => setAssetReleaseId(release.id)}
                >
                  Add asset
                </Button>
                {release.status === 'draft' ? (
                  <Button
                    size="sm"
                    disabled={publishDisabled.disabled || busyKey === `publish-${release.id}`}
                    title={publishDisabled.title}
                    onClick={() => setPublishId(release.id)}
                  >
                    Publish
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={publishRelease !== null}
        onOpenChange={(next) => {
          if (!next) setPublishId(null)
        }}
        title={publishRelease ? `Publish ${publishRelease.version}?` : 'Publish release?'}
        description="Publishing makes this release visible to everyone with access to the codebase."
        confirmLabel="Publish release"
        busy={publishRelease !== null && busyKey === `publish-${publishRelease.id}`}
        onConfirm={() => {
          if (!publishRelease) return
          void runMutation({
            key: `publish-${publishRelease.id}`,
            label: 'publish the release',
            run: () =>
              updateCollaborationItem({
                action: 'publishRelease',
                codebaseId,
                releaseId: publishRelease.id,
                updatedBy: actorId,
              }),
            successTitle: `${publishRelease.version} published`,
          }).then((ok) => {
            if (ok) setPublishId(null)
          })
        }}
      />
      {assetRelease ? (
        <AddAssetDialog
          release={assetRelease}
          onClose={() => setAssetReleaseId(null)}
          codebaseId={codebaseId}
          actorId={actorId}
          busy={busyKey === `add-asset-${assetRelease.id}`}
          runMutation={runMutation}
        />
      ) : null}
      <NewReleaseDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        codebaseId={codebaseId}
        actorId={actorId}
        busy={busyKey === 'create-release'}
        runMutation={runMutation}
        releaseTarget={releaseTarget}
      />
    </div>
  )
}
