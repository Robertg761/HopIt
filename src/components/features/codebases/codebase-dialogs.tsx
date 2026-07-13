'use client'

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace, type CodebaseSummary } from '@/components/workspace/workspace-provider'
import { createCodebase, deleteCodebase, renameCodebase, type ApiError } from './codebases-api'

function DialogActions({
  busy,
  busyLabel,
  submitLabel,
  destructive,
  disabled,
  onCancel,
}: {
  busy: boolean
  busyLabel: string
  submitLabel: string
  destructive?: boolean
  disabled?: boolean
  onCancel: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy || disabled}>
        {busy ? <Spinner className="size-3.5 text-current" /> : null}
        {busy ? busyLabel : submitLabel}
      </Button>
    </div>
  )
}

function useApiErrorToast() {
  const { toast } = useToast()
  return React.useCallback(
    (title: string, error: ApiError) => {
      if (error.code === 'browser_auth_required') {
        toast({ title: 'Sign in required', description: 'Sign in to manage codebases.' })
      } else if (error.code === 'quota_exceeded_codebases') {
        toast({
          title: 'Free project used',
          description: error.message,
          action: (
            <ToastAction altText="View HopIt plans" onClick={() => window.location.assign('/pricing')}>
              View plans
            </ToastAction>
          ),
        })
      } else {
        toast({ title, description: error.message, variant: 'destructive' })
      }
    },
    [toast],
  )
}

export function NewCodebaseDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { refreshCodebases } = useWorkspace()
  const { toast } = useToast()
  const showApiError = useApiErrorToast()
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
    }
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    const result = await createCodebase({ name: trimmed, description: description.trim() || undefined })
    setBusy(false)
    if (result.ok) {
      toast({ title: 'Codebase created', description: `${trimmed} is ready in the cloud.` })
      await refreshCodebases()
      onOpenChange(false)
    } else {
      showApiError('Could not create codebase', result.error)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New codebase"
      description="Creates an empty cloud codebase you can attach on any device."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="new-codebase-name">
          <Input
            id="new-codebase-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-project"
            autoFocus
            required
          />
        </Field>
        <Field label="Description" htmlFor="new-codebase-description" hint="Optional.">
          <Textarea
            id="new-codebase-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What lives here?"
          />
        </Field>
        <DialogActions
          busy={busy}
          busyLabel="Creating…"
          submitLabel="Create codebase"
          disabled={!name.trim()}
          onCancel={() => onOpenChange(false)}
        />
      </form>
    </Dialog>
  )
}

export function ImportGitDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { runCommand, status, refreshCodebases } = useWorkspace()
  const { toast } = useToast()
  const [url, setUrl] = React.useState('')
  const [branch, setBranch] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const commandsAvailable = status.commandsAvailable

  React.useEffect(() => {
    if (open) {
      setUrl('')
      setBranch('')
    }
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedUrl = url.trim()
    if (!trimmedUrl || busy || !commandsAvailable) return
    setBusy(true)
    const result = await runCommand('importGitUrl', {
      url: trimmedUrl,
      branch: branch.trim() || undefined,
    })
    setBusy(false)
    if (result.ok) {
      toast({ title: 'Import complete', description: result.summary ?? `Imported ${trimmedUrl}.` })
      await refreshCodebases()
      onOpenChange(false)
    } else {
      toast({
        title: 'Import failed',
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import from Git"
      description="Clones a Git repository into a new cloud codebase. This can take a while for large repos."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Repository URL" htmlFor="import-git-url">
          <Input
            id="import-git-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/user/repo.git"
            className="font-mono"
            autoFocus
            required
          />
        </Field>
        <Field label="Branch" htmlFor="import-git-branch" hint="Optional — defaults to the repository default branch.">
          <Input
            id="import-git-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            className="font-mono"
          />
        </Field>
        {!commandsAvailable ? (
          <p className="text-xs text-muted-foreground">Importing is available from the local agent.</p>
        ) : null}
        <DialogActions
          busy={busy}
          busyLabel="Importing…"
          submitLabel="Import repository"
          disabled={!url.trim() || !commandsAvailable}
          onCancel={() => onOpenChange(false)}
        />
      </form>
    </Dialog>
  )
}

export function RenameCodebaseDialog({
  codebase,
  onClose,
}: {
  codebase: CodebaseSummary | null
  onClose: () => void
}) {
  const { refreshCodebases } = useWorkspace()
  const { toast } = useToast()
  const showApiError = useApiErrorToast()
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    setName(codebase?.name ?? '')
  }, [codebase?.id, codebase?.name])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!codebase || !trimmed || busy) return
    setBusy(true)
    const result = await renameCodebase({ codebaseId: codebase.id, name: trimmed })
    setBusy(false)
    if (result.ok) {
      toast({ title: 'Codebase renamed', description: `${codebase.name} is now ${trimmed}.` })
      await refreshCodebases()
      onClose()
    } else {
      showApiError('Could not rename codebase', result.error)
    }
  }

  return (
    <Dialog
      open={codebase !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Rename codebase"
      description={codebase ? `Give ${codebase.name} a new name. The id stays the same.` : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="rename-codebase-name">
          <Input
            id="rename-codebase-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
          />
        </Field>
        <DialogActions
          busy={busy}
          busyLabel="Renaming…"
          submitLabel="Rename"
          disabled={!name.trim()}
          onCancel={onClose}
        />
      </form>
    </Dialog>
  )
}

export function DeleteCodebaseDialog({
  codebase,
  onClose,
}: {
  codebase: CodebaseSummary | null
  onClose: () => void
}) {
  const { refreshCodebases } = useWorkspace()
  const { toast } = useToast()
  const showApiError = useApiErrorToast()
  const [busy, setBusy] = React.useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!codebase || busy) return
    setBusy(true)
    const result = await deleteCodebase({ codebaseId: codebase.id })
    setBusy(false)
    if (result.ok) {
      toast({ title: 'Codebase deleted', description: `${codebase.name} was removed from the cloud.` })
      await refreshCodebases()
      onClose()
    } else {
      showApiError('Could not delete codebase', result.error)
    }
  }

  return (
    <Dialog
      open={codebase !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Delete codebase"
      description="This cannot be undone."
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Permanently deletes <span className="font-medium text-foreground">{codebase?.name}</span>{' '}
          (<span className="font-mono text-xs">{codebase?.id}</span>) and its cloud files for every
          member.
        </p>
        <DialogActions
          busy={busy}
          busyLabel="Deleting…"
          submitLabel="Delete codebase"
          destructive
          onCancel={onClose}
        />
      </form>
    </Dialog>
  )
}
