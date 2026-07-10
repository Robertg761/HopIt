'use client'

import * as React from 'react'
import { FileCode2, PencilLine, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import type { AgentFile } from '@/lib/client/agent-status'
import { formatBytes } from '@/lib/client/format'
import { fetchCodebaseFile, saveCodebaseFile, type FileApiFailure } from './files-api'

/** Preview + open/edit/save flow for one cloud file. Mount with key={file.path}. */
export function FileEditor({ file, codebaseId }: { file: AgentFile; codebaseId: string | null }) {
  const { refresh } = useWorkspace()
  const { toast } = useToast()
  const [editing, setEditing] = React.useState(false)
  const [opening, setOpening] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [content, setContent] = React.useState('')
  const [baseRevision, setBaseRevision] = React.useState<number | null>(null)
  const [selectedStateId, setSelectedStateId] = React.useState<string | null>(null)

  const showFailure = (title: string, error: FileApiFailure) => {
    if (error.code === 'browser_auth_required') {
      toast({ title: 'Sign in required', description: 'Sign in to edit files.' })
    } else {
      toast({ title, description: error.message, variant: 'destructive' })
    }
  }

  if (file.kind !== 'file') {
    return (
      <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {file.kind === 'symlink'
          ? `Symlink${file.target ? ` to ${file.target}` : ''} — nothing to edit.`
          : 'Directory entry — nothing to edit.'}
      </p>
    )
  }

  if (file.encoding === 'base64') {
    return (
      <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Binary file ({formatBytes(file.size)}) — editing is not available.
      </p>
    )
  }

  const openFile = async () => {
    if (!codebaseId || opening) return
    setOpening(true)
    const result = await fetchCodebaseFile(codebaseId, file.path)
    setOpening(false)
    if (!result.ok) {
      showFailure('Could not open file', result)
      return
    }
    setContent(result.content)
    setBaseRevision(result.revision ?? file.revision)
    setSelectedStateId(result.selectedStateId)
    setEditing(true)
  }

  const save = async () => {
    if (!codebaseId || !selectedStateId || saving) return
    setSaving(true)
    const result = await saveCodebaseFile({
      codebaseId,
      path: file.path,
      content,
      baseRevision,
      selectedStateId,
    })
    setSaving(false)
    if (!result.ok) {
      showFailure('Save failed', result)
      return
    }
    setBaseRevision(result.revision)
    setSelectedStateId(result.selectedStateId)
    toast({
      title: 'File saved',
      description:
        result.revision !== null ? `${file.path} saved at revision ${result.revision}.` : `${file.path} saved.`,
    })
    void refresh()
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        {file.contentPreview !== null ? (
          <div>
            <pre className="scroll-thin max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {file.contentPreview}
            </pre>
            {file.contentPreviewTruncated ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Preview truncated — open the file to see everything.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode2 className="size-3.5" aria-hidden /> No preview available for this file.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openFile()}
          disabled={opening || !codebaseId}
          title={codebaseId ? undefined : 'Select a codebase first'}
        >
          {opening ? <Spinner className="size-3.5" /> : <PencilLine />}
          {opening ? 'Opening…' : 'Open file'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="min-h-80 font-mono text-xs leading-relaxed"
        aria-label={`Contents of ${file.path}`}
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !selectedStateId}>
          {saving ? <Spinner className="size-3.5 text-primary-foreground" /> : <Save />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
          Close editor
        </Button>
        {baseRevision !== null ? (
          <span className="text-xs text-muted-foreground">
            Base revision <span className="font-mono">{baseRevision}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
