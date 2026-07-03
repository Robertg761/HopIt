'use client'

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  createCollaborationItem,
  type CollaborationRelease,
  type CollaborationReleaseAsset,
} from '@/lib/collaboration'
import { type RunWorkMutation } from './work-common'

type AssetKind = CollaborationReleaseAsset['kind']

const ASSET_KINDS: AssetKind[] = ['archive', 'binary', 'source', 'checksum', 'installer', 'other']

export function AddAssetDialog({
  release,
  onClose,
  codebaseId,
  actorId,
  busy,
  runMutation,
}: {
  release: CollaborationRelease
  onClose: () => void
  codebaseId: string
  actorId: string
  busy: boolean
  runMutation: RunWorkMutation
}) {
  const [name, setName] = React.useState('')
  const [kind, setKind] = React.useState<AssetKind>('archive')
  const [url, setUrl] = React.useState('')
  const [size, setSize] = React.useState('')
  const [checksum, setChecksum] = React.useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    const parsedSize = Number(size)
    const ok = await runMutation({
      key: `add-asset-${release.id}`,
      label: 'add the asset',
      run: () =>
        createCollaborationItem({
          type: 'releaseAsset',
          codebaseId,
          releaseId: release.id,
          name: name.trim(),
          kind,
          url: url.trim() || undefined,
          size: size.trim() && Number.isFinite(parsedSize) ? parsedSize : undefined,
          checksum: checksum.trim() || undefined,
          createdBy: actorId,
        }),
      successTitle: 'Asset added',
    })
    if (ok) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={`Add asset to ${release.version}`}
      description="Attach a downloadable artifact to this release."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor="asset-name">
            <Input
              id="asset-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="app-darwin-arm64.zip"
              required
              autoFocus
            />
          </Field>
          <Field label="Kind" htmlFor="asset-kind">
            <Select id="asset-kind" value={kind} onChange={(event) => setKind(event.target.value as AssetKind)}>
              {ASSET_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="URL" htmlFor="asset-url">
          <Input
            id="asset-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            type="url"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Size (bytes)" htmlFor="asset-size">
            <Input
              id="asset-size"
              value={size}
              onChange={(event) => setSize(event.target.value)}
              type="number"
              min={0}
              placeholder="1048576"
            />
          </Field>
          <Field label="Checksum" htmlFor="asset-checksum">
            <Input
              id="asset-checksum"
              value={checksum}
              onChange={(event) => setChecksum(event.target.value)}
              placeholder="sha256:…"
              className="font-mono"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Add asset
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function NewReleaseDialog({
  open,
  onOpenChange,
  codebaseId,
  actorId,
  busy,
  runMutation,
  releaseTarget,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebaseId: string
  actorId: string
  busy: boolean
  runMutation: RunWorkMutation
  releaseTarget: CollaborationRelease['target'] | undefined
}) {
  const [version, setVersion] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [notes, setNotes] = React.useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!version.trim() || !title.trim() || !notes.trim()) return
    const ok = await runMutation({
      key: 'create-release',
      label: 'create the release',
      run: () =>
        createCollaborationItem({
          type: 'release',
          codebaseId,
          version: version.trim(),
          title: title.trim(),
          notes: notes.trim(),
          target: releaseTarget,
          createdBy: actorId,
        }),
      successTitle: 'Draft release created',
    })
    if (ok) {
      setVersion('')
      setTitle('')
      setNotes('')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New release" description="Drafts stay private until you publish.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Field label="Version" htmlFor="release-version">
            <Input
              id="release-version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="v1.2.0"
              className="font-mono"
              required
              autoFocus
            />
          </Field>
          <Field label="Title" htmlFor="release-title">
            <Input
              id="release-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Spring cleanup"
              required
            />
          </Field>
        </div>
        <Field
          label="Notes"
          htmlFor="release-notes"
          hint={releaseTarget ? `Targets main at revision ${releaseTarget.revision ?? 'latest'}.` : undefined}
        >
          <Textarea
            id="release-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="What changed in this release?"
            rows={4}
            required
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !version.trim() || !title.trim() || !notes.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Create draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
