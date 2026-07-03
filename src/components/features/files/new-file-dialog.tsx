'use client'

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { saveCodebaseFile } from './files-api'

export function NewFileDialog({
  open,
  onOpenChange,
  codebaseId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebaseId: string | null
  onCreated: (path: string) => void
}) {
  const { toast } = useToast()
  const [path, setPath] = React.useState('')
  const [content, setContent] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setPath('')
      setContent('')
    }
  }, [open])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = path.trim().replace(/^\/+/, '')
    if (!trimmed || !codebaseId || busy) return
    setBusy(true)
    const result = await saveCodebaseFile({ codebaseId, path: trimmed, content })
    setBusy(false)
    if (result.ok) {
      toast({ title: 'File created', description: trimmed })
      onOpenChange(false)
      onCreated(trimmed)
    } else if (result.code === 'browser_auth_required') {
      toast({ title: 'Sign in required', description: 'Sign in to edit files.' })
    } else {
      toast({ title: 'Could not create file', description: result.message, variant: 'destructive' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New file"
      description="Creates a cloud file in the selected codebase."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Path" htmlFor="new-file-path" hint="Relative to the codebase root, e.g. docs/notes.md">
          <Input
            id="new-file-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="src/index.ts"
            className="font-mono"
            autoFocus
            required
          />
        </Field>
        <Field label="Initial content" htmlFor="new-file-content" hint="Optional.">
          <Textarea
            id="new-file-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-40 font-mono text-xs leading-relaxed"
            spellCheck={false}
          />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !path.trim() || !codebaseId}>
            {busy ? <Spinner className="size-3.5 text-primary-foreground" /> : null}
            {busy ? 'Creating…' : 'Create file'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
