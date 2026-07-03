'use client'

import * as React from 'react'
import { Archive, ExternalLink } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatBytes } from '@/lib/client/format'
import {
  updateCollaborationItem,
  type CollaborationProject,
  type CollaborationRelease,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import { projectItemRef, projectItemTitle } from './project-board'
import {
  ConfirmDialog,
  RELEASE_STATUS_TONE,
  RelativeTime,
  capabilityProps,
  type RunWorkMutation,
} from './work-common'

export function ReleaseDetailSection({
  release,
  codebaseId,
  actorId,
  capabilities,
  busyKey,
  runMutation,
}: {
  release: CollaborationRelease
  codebaseId: string
  actorId: string
  capabilities: WorkItemsResponse['capabilities']
  busyKey: string | null
  runMutation: RunWorkMutation
}) {
  const [confirmPublish, setConfirmPublish] = React.useState(false)
  const publishDisabled = capabilityProps(capabilities.publishRelease)
  const publishKey = `publish-${release.id}`

  return (
    <>
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={RELEASE_STATUS_TONE[release.status]}>{release.status}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{release.createdBy}</span>
            <RelativeTime value={release.publishedAt ?? release.createdAt} />
            {release.status === 'draft' ? (
              <Button
                size="sm"
                className="ml-auto"
                disabled={publishDisabled.disabled || busyKey === publishKey}
                title={publishDisabled.title}
                onClick={() => setConfirmPublish(true)}
              >
                Publish
              </Button>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground">{release.notes || 'No release notes.'}</p>
          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-xs font-medium text-foreground">Target</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone="outline">{release.target.type}</Badge>
              <span className="font-mono">{release.target.id}</span>
              <span>{release.target.revision !== null ? `revision ${release.target.revision}` : 'latest revision'}</span>
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Assets ({release.assets.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {release.assets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No assets attached to this release.</p>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Kind</th>
                    <th className="pb-2 pr-4 font-medium">Size</th>
                    <th className="pb-2 pr-4 font-medium">Checksum</th>
                    <th className="pb-2 font-medium">URL</th>
                  </tr>
                </thead>
                <tbody>
                  {release.assets.map((asset) => (
                    <tr key={asset.id} className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-4 font-medium text-foreground">{asset.name}</td>
                      <td className="py-2 pr-4">
                        <Badge tone="outline">{asset.kind}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{formatBytes(asset.size)}</td>
                      <td className="py-2 pr-4">
                        {asset.checksum ? (
                          <span className="font-mono text-xs text-muted-foreground" title={asset.checksum}>
                            {asset.checksum.length > 16 ? `${asset.checksum.slice(0, 16)}…` : asset.checksum}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        {asset.url ? (
                          <a
                            href={asset.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-sm text-xs text-iris outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                          >
                            Open
                            <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish ${release.version}?`}
        description="Publishing makes this release visible to everyone with access to the codebase."
        confirmLabel="Publish release"
        busy={busyKey === publishKey}
        onConfirm={() =>
          void runMutation({
            key: publishKey,
            label: 'publish the release',
            run: () =>
              updateCollaborationItem({
                action: 'publishRelease',
                codebaseId,
                releaseId: release.id,
                updatedBy: actorId,
              }),
            successTitle: `${release.version} published`,
          }).then((ok) => {
            if (ok) setConfirmPublish(false)
          })
        }
      />
    </>
  )
}

export function ProjectDetailSection({
  project,
  codebaseId,
  actorId,
  capabilities,
  busyKey,
  runMutation,
}: {
  project: CollaborationProject
  codebaseId: string
  actorId: string
  capabilities: WorkItemsResponse['capabilities']
  busyKey: string | null
  runMutation: RunWorkMutation
}) {
  const [confirmArchive, setConfirmArchive] = React.useState(false)
  const updateDisabled = capabilityProps(capabilities.updateProject)
  const archiveKey = `archive-project-${project.id}`

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={project.status === 'active' ? 'hop' : 'neutral'}>{project.status}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{project.createdBy}</span>
          <RelativeTime value={project.archivedAt ?? project.updatedAt} />
          {project.status === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={updateDisabled.disabled || busyKey === archiveKey}
              title={updateDisabled.title}
              onClick={() => setConfirmArchive(true)}
            >
              <Archive className="size-3.5" />
              Archive
            </Button>
          ) : null}
        </div>
        {project.description ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">{project.description}</p>
        ) : null}
        <div className="scroll-thin overflow-x-auto pb-1">
          <div className="flex min-w-max gap-3">
            {project.columns.map((column) => {
              const items = project.items
                .filter((item) => item.columnId === column.id)
                .sort((a, b) => a.position - b.position)
              return (
                <div key={column.id} className="w-64 shrink-0 rounded-lg bg-muted/40 p-3">
                  <p className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">
                    {column.name}
                    <span className="tabular-nums text-muted-foreground">{items.length}</span>
                  </p>
                  <ul className="space-y-2">
                    {items.map((item) => {
                      const ref = projectItemRef(item)
                      return (
                        <li key={item.id} className="rounded-lg border border-border bg-card p-2.5">
                          <p className="text-sm text-foreground">{projectItemTitle(item)}</p>
                          {ref ? <p className="mt-0.5 font-mono text-xs text-muted-foreground">{ref}</p> : null}
                        </li>
                      )
                    })}
                    {items.length === 0 ? <li className="text-xs text-muted-foreground">Empty</li> : null}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${project.name}?`}
        description="The board is hidden from the active list. Items are kept."
        confirmLabel="Archive project"
        busy={busyKey === archiveKey}
        destructive
        onConfirm={() =>
          void runMutation({
            key: archiveKey,
            label: 'archive the project',
            run: () =>
              updateCollaborationItem({
                action: 'archiveProject',
                codebaseId,
                projectId: project.id,
                updatedBy: actorId,
              }),
            successTitle: 'Project archived',
          }).then((ok) => {
            if (ok) setConfirmArchive(false)
          })
        }
      />
    </Card>
  )
}
