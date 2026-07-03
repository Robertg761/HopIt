'use client'

import * as React from 'react'
import Link from 'next/link'
import { Archive, KanbanSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { createCollaborationItem } from '@/lib/collaboration'
import { ProjectBoard } from './project-board'
import {
  RelativeTime,
  capabilityProps,
  workItemHref,
  type RunWorkMutation,
  type WorkTabProps,
} from './work-common'

export function ProjectsTab({
  codebaseId,
  actorId,
  data,
  busyKey,
  runMutation,
  createOpen,
  onCreateOpenChange,
}: WorkTabProps) {
  const active = data.projects.filter((project) => project.status === 'active')
  const archived = data.projects.filter((project) => project.status === 'archived')
  const updateDisabled = capabilityProps(data.capabilities.updateProject)

  return (
    <div className="space-y-6">
      {active.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="No active projects"
          description="Projects organize issues, notes, and releases into boards."
        />
      ) : (
        active.map((project) => (
          <ProjectBoard
            key={project.id}
            project={project}
            codebaseId={codebaseId}
            actorId={actorId}
            busyKey={busyKey}
            runMutation={runMutation}
            updateDisabled={updateDisabled}
          />
        ))
      )}
      {archived.length > 0 ? (
        <details className="rounded-xl border border-border">
          <summary className="cursor-pointer list-none rounded-xl px-4 py-3 text-sm font-medium hover:bg-muted/50">
            Archived projects ({archived.length})
          </summary>
          <ul className="border-t border-border p-2">
            {archived.map((project) => (
              <li key={project.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50">
                <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Link
                  href={workItemHref(codebaseId, 'project', project.id)}
                  className="min-w-0 flex-1 truncate rounded-sm text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {project.name}
                </Link>
                <span className="text-xs text-muted-foreground">archived</span>
                <RelativeTime value={project.archivedAt} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <NewProjectDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        codebaseId={codebaseId}
        actorId={actorId}
        busy={busyKey === 'create-project'}
        runMutation={runMutation}
      />
    </div>
  )
}

function NewProjectDialog({
  open,
  onOpenChange,
  codebaseId,
  actorId,
  busy,
  runMutation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebaseId: string
  actorId: string
  busy: boolean
  runMutation: RunWorkMutation
}) {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    const ok = await runMutation({
      key: 'create-project',
      label: 'create the project',
      run: () =>
        createCollaborationItem({
          type: 'project',
          codebaseId,
          name: name.trim(),
          description: description.trim() || undefined,
          createdBy: actorId,
        }),
      successTitle: 'Project created',
    })
    if (ok) {
      setName('')
      setDescription('')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New project" description="A board to organize work into columns.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="new-project-name">
          <Input
            id="new-project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Launch checklist"
            required
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor="new-project-description">
          <Textarea
            id="new-project-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this board for?"
            rows={3}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
