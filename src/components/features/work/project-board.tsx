'use client'

import * as React from 'react'
import Link from 'next/link'
import { Archive, ChevronLeft, ChevronRight, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  createCollaborationItem,
  updateCollaborationItem,
  type CollaborationProject,
  type CollaborationProjectItem,
} from '@/lib/collaboration'
import { ConfirmDialog, workItemHref, type RunWorkMutation } from './work-common'

export function projectItemTitle(item: CollaborationProjectItem): string {
  return item.item.title ?? item.item.version ?? 'Untitled item'
}

export function projectItemRef(item: CollaborationProjectItem): string | null {
  const type = item.item.type
  if (!type || type === 'note') return null
  return item.item.id ? `${type} · ${item.item.id.slice(0, 8)}` : type
}

export type ProjectBoardProps = {
  project: CollaborationProject
  codebaseId: string
  actorId: string
  busyKey: string | null
  runMutation: RunWorkMutation
  updateDisabled: { disabled: boolean; title: string | undefined }
}

export function ProjectBoard({
  project,
  codebaseId,
  actorId,
  busyKey,
  runMutation,
  updateDisabled,
}: ProjectBoardProps) {
  const [confirmArchive, setConfirmArchive] = React.useState(false)
  const archiveKey = `archive-project-${project.id}`

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={workItemHref(codebaseId, 'project', project.id)}
            className="rounded-sm text-sm font-semibold tracking-tight outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {project.name}
          </Link>
          {project.description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{project.description}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={updateDisabled.disabled || busyKey === archiveKey}
          title={updateDisabled.title}
          onClick={() => setConfirmArchive(true)}
        >
          <Archive className="size-3.5" />
          Archive
        </Button>
      </div>
      <div className="scroll-thin overflow-x-auto pb-1">
        <div className="flex min-w-max gap-3">
          {project.columns.map((column, columnIndex) => {
            const items = project.items
              .filter((item) => item.columnId === column.id)
              .sort((a, b) => a.position - b.position)
            return (
              <div key={column.id} className="w-64 shrink-0 rounded-lg bg-muted/40 p-3">
                <p className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">
                  {column.name}
                  <span className="tabular-nums text-muted-foreground">{items.length}</span>
                </p>
                <div className="space-y-2">
                  {items.map((item) => (
                    <ProjectItemCard
                      key={item.id}
                      item={item}
                      project={project}
                      codebaseId={codebaseId}
                      actorId={actorId}
                      busyKey={busyKey}
                      runMutation={runMutation}
                      updateDisabled={updateDisabled}
                    />
                  ))}
                  {columnIndex === 0 ? (
                    <NoteComposer
                      project={project}
                      codebaseId={codebaseId}
                      actorId={actorId}
                      busy={busyKey === `add-note-${project.id}`}
                      runMutation={runMutation}
                      updateDisabled={updateDisabled}
                    />
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
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

function ProjectItemCard({
  item,
  project,
  codebaseId,
  actorId,
  busyKey,
  runMutation,
  updateDisabled,
}: ProjectBoardProps & { item: CollaborationProjectItem }) {
  const columnIndex = project.columns.findIndex((column) => column.id === item.columnId)
  const moveKey = `move-item-${item.id}`
  const busy = busyKey === moveKey
  const ref = projectItemRef(item)

  function move(direction: -1 | 1) {
    const target = project.columns[columnIndex + direction]
    if (!target) return
    void runMutation({
      key: moveKey,
      label: 'move the card',
      run: () =>
        updateCollaborationItem({
          action: 'moveProjectItem',
          codebaseId,
          projectItemId: item.id,
          columnId: target.id,
          updatedBy: actorId,
        }),
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <p className="text-sm text-foreground">{projectItemTitle(item)}</p>
      {ref ? <p className="mt-0.5 font-mono text-xs text-muted-foreground">{ref}</p> : null}
      <div className="mt-1.5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move card left"
          disabled={updateDisabled.disabled || busy || columnIndex <= 0}
          title={updateDisabled.title}
          onClick={() => move(-1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        {busy ? <Spinner className="size-3.5" /> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Move card right"
          disabled={updateDisabled.disabled || busy || columnIndex >= project.columns.length - 1}
          title={updateDisabled.title}
          onClick={() => move(1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

function NoteComposer({
  project,
  codebaseId,
  actorId,
  busy,
  runMutation,
  updateDisabled,
}: {
  project: CollaborationProject
  codebaseId: string
  actorId: string
  busy: boolean
  runMutation: RunWorkMutation
  updateDisabled: { disabled: boolean; title: string | undefined }
}) {
  const [title, setTitle] = React.useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    const ok = await runMutation({
      key: `add-note-${project.id}`,
      label: 'add the note',
      run: () =>
        createCollaborationItem({
          type: 'projectItem',
          codebaseId,
          projectId: project.id,
          item: { type: 'note', title: trimmed, body: null },
          columnId: project.columns[0]?.id,
          createdBy: actorId,
        }),
    })
    if (ok) setTitle('')
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-1.5">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add a note…"
        aria-label={`Add a note to ${project.name}`}
        disabled={updateDisabled.disabled}
        title={updateDisabled.title}
        className="h-7 text-xs"
      />
      <Button
        type="submit"
        variant="outline"
        size="icon-sm"
        aria-label="Add note"
        disabled={updateDisabled.disabled || busy || !title.trim()}
        title={updateDisabled.title}
      >
        {busy ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
      </Button>
    </form>
  )
}
