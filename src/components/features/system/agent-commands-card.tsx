'use client'

import * as React from 'react'
import {
  CloudDownload,
  CloudOff,
  Eraser,
  GitBranch,
  LifeBuoy,
  RefreshCw,
  RotateCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import type {
  AgentCommand,
  AgentCommandPayload,
  AgentCommandResult,
} from '@/components/workspace/workspace-provider'

import { QuietNote } from './shared'

const COMMANDS: Array<{ command: AgentCommand; label: string; icon: LucideIcon }> = [
  { command: 'refresh', label: 'Refresh', icon: RotateCw },
  { command: 'sync', label: 'Sync now', icon: RefreshCw },
  { command: 'recover', label: 'Recover', icon: LifeBuoy },
  { command: 'hydrateWorkspace', label: 'Hydrate workspace', icon: CloudDownload },
  { command: 'dehydrateWorkspace', label: 'Dehydrate workspace', icon: CloudOff },
]

export function CommandsCard({
  commandsAvailable,
  runningCommand,
  commandResult,
  runCommand,
}: {
  commandsAvailable: boolean
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
}) {
  const { toast } = useToast()
  const [confirmPrune, setConfirmPrune] = React.useState(false)
  const busy = runningCommand !== null

  async function run(command: AgentCommand, payload?: AgentCommandPayload) {
    const result = await runCommand(command, payload)
    if (!result.ok) {
      toast({
        title: `${result.label ?? command} failed`,
        description: result.error?.message ?? result.stderr ?? 'The agent command failed.',
        variant: 'destructive',
      })
    }
    return result
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commands</CardTitle>
        <CardDescription>Workspace operations executed by the local agent.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!commandsAvailable ? <QuietNote>Available from the local agent only.</QuietNote> : null}
        <div className="flex flex-wrap gap-2">
          {COMMANDS.map(({ command, label, icon: Icon }) => (
            <Button
              key={command}
              variant="outline"
              size="sm"
              disabled={!commandsAvailable || busy}
              onClick={() => void run(command)}
            >
              {runningCommand === command ? <Spinner className="size-3.5" /> : <Icon className="size-4" />}
              {label}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!commandsAvailable || busy}
            onClick={() => setConfirmPrune(true)}
          >
            {runningCommand === 'pruneWorkspace' ? <Spinner className="size-3.5" /> : <Eraser className="size-4" />}
            Free local cache
          </Button>
        </div>
        <CommandResultPanel result={commandResult} />
      </CardContent>

      <Dialog
        open={confirmPrune}
        onOpenChange={setConfirmPrune}
        title="Free local cache"
        description="Prunable files are removed from disk; they stay in the cloud and re-hydrate on demand."
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmPrune(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmPrune(false)
                void run('pruneWorkspace', { execute: true })
              }}
            >
              Free cache
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Remove prunable hydrated files from this device? Pinned and dirty files are kept.
        </p>
      </Dialog>
    </Card>
  )
}

export function ImportGitCard({
  commandsAvailable,
  runningCommand,
  runCommand,
}: {
  commandsAvailable: boolean
  runningCommand: AgentCommand | null
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
}) {
  const { toast } = useToast()
  const [url, setUrl] = React.useState('')
  const [branch, setBranch] = React.useState('')
  const busy = runningCommand !== null
  const importing = runningCommand === 'importGitUrl'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!url.trim() || busy || !commandsAvailable) return
    const result = await runCommand('importGitUrl', {
      url: url.trim(),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    })
    if (result.ok) {
      setUrl('')
      setBranch('')
      toast({ title: 'Import started', description: result.summary ?? 'The agent is importing the repository.' })
    } else {
      toast({
        title: 'Import failed',
        description: result.error?.message ?? result.stderr ?? 'The import command failed.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from Git</CardTitle>
        <CardDescription>Clone a Git repository into this codebase via the agent.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!commandsAvailable ? <QuietNote>Available from the local agent only.</QuietNote> : null}
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="Repository URL" htmlFor="import-git-url" className="min-w-64 flex-1">
            <Input
              id="import-git-url"
              placeholder="https://github.com/org/repo.git"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="font-mono text-xs"
              disabled={!commandsAvailable || busy}
            />
          </Field>
          <Field label="Branch" htmlFor="import-git-branch" hint="Optional — defaults to the remote default branch." className="w-44">
            <Input
              id="import-git-branch"
              placeholder="main"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              className="font-mono text-xs"
              disabled={!commandsAvailable || busy}
            />
          </Field>
          <Button type="submit" disabled={!commandsAvailable || busy || !url.trim()}>
            {importing ? <Spinner className="size-3.5" /> : <GitBranch className="size-4" />}
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Large repositories can take a while — the agent keeps working after you leave this page.
        </p>
      </CardContent>
    </Card>
  )
}

function CommandResultPanel({ result }: { result: AgentCommandResult | null }) {
  if (!result) return null
  const output = [result.stdout, result.stderr].filter((part): part is string => Boolean(part && part.trim()))

  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.ok ? 'hop' : 'danger'}>{result.ok ? 'ok' : 'failed'}</Badge>
        <span className="text-sm font-medium">{result.label ?? result.command}</span>
        {result.summary ? <span className="text-xs text-muted-foreground">{result.summary}</span> : null}
      </div>
      {result.error?.message ? <p className="text-xs text-danger">{result.error.message}</p> : null}
      {output.length > 0 ? (
        <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-xs leading-relaxed">
          {output.join('\n')}
        </pre>
      ) : null}
    </div>
  )
}
