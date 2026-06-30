'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Activity,
  CheckCircle2,
  Cloud,
  Clock3,
  FileStack,
  FlaskConical,
  FolderOpen,
  GitBranch,
  HardDrive,
  GitMerge,
  GitPullRequest,
  Hammer,
  Play,
  RotateCcw,
  ShieldCheck,
  Terminal,
  UploadCloud,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'
import type {
  AgentCommand,
  AgentCommandPayload,
  AgentCommandResult,
} from '@/website/hooks/use-agent-status'

const cacheStateLabels: Record<AgentStatusSnapshot['cacheState'], string> = {
  ready: 'Ready',
  syncing: 'Syncing',
  offline: 'Offline',
  blocked: 'Blocked',
}

const privateScopeLabels: Record<AgentStatusSnapshot['privateScope'], string> = {
  scoped: 'Private scope active',
  none: 'No private scope',
}

const eventToneClasses: Record<AgentEvent['tone'], string> = {
  ready: 'bg-primary/10 text-primary border border-primary/20',
  syncing: 'bg-sky-500/10 text-sky-500 border border-sky-500/20',
  queued: 'bg-hop-amber/10 text-hop-amber border border-hop-amber/20',
  observed: 'bg-grape/10 text-grape border border-grape/20',
  blocked: 'bg-destructive/10 text-destructive border border-destructive/20',
}

type AgentEvent = AgentStatusSnapshot['events'][number]
type ActionKind = 'lint' | 'test' | 'build'
type ActionJob = {
  jobId: string
  kind: ActionKind
  status: string
  summary: string | null
  exitCode: number | null
  createdAt: string
  updatedAt: string
}

type RightRailProps = {
  status: AgentStatusSnapshot
  loading: boolean
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}

const prototypeActions: Array<{
  command: AgentCommand
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { command: 'sync', label: 'Sync', icon: UploadCloud },
  { command: 'refresh', label: 'Refresh', icon: Cloud },
  { command: 'recover', label: 'Recover', icon: CheckCircle2 },
  { command: 'review', label: 'Review', icon: GitPullRequest },
  { command: 'merge', label: 'Merge', icon: GitMerge },
]

export function RightRail({
  status,
  loading,
  runCommand,
  runningCommand,
  commandResult,
}: RightRailProps) {
  return (
    <aside className="flex flex-col gap-4">
      <AgentStatusPanel
        status={status}
        loading={loading}
        runCommand={runCommand}
        runningCommand={runningCommand}
        commandResult={commandResult}
      />
    </aside>
  )
}

function AgentStatusPanel({
  status,
  loading,
  runCommand,
  runningCommand,
  commandResult,
}: {
  status: AgentStatusSnapshot
  loading: boolean
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}) {
  const isOnline = status.state === 'online' || status.state === 'syncing'
  const isBlocked = status.state === 'blocked'
  const StatusIcon = status.state === 'offline' ? WifiOff : HardDrive
  const [gitUrl, setGitUrl] = React.useState('')
  const [gitBranch, setGitBranch] = React.useState('')
  const [actionJobs, setActionJobs] = React.useState<ActionJob[]>([])
  const [actionLoading, setActionLoading] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const trimmedGitUrl = gitUrl.trim()
  const importRunning = runningCommand === 'importGitUrl'
  const importDisabledReason = remoteImportDisabledReason(status, runningCommand, trimmedGitUrl)

  const loadActionJobs = React.useCallback(async () => {
    if (!status.codebaseId) {
      setActionJobs([])
      return
    }

    try {
      const response = await fetch(`/api/actions?codebaseId=${encodeURIComponent(status.codebaseId)}`, {
        cache: 'no-store',
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Action list failed.')
      }
      setActionJobs(Array.isArray(body.jobs) ? body.jobs.map(normalizeActionJob) : [])
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action list failed.')
    }
  }, [status.codebaseId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadActionJobs()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadActionJobs])

  function submitRemoteImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (importDisabledReason) return

    void runCommand('importGitUrl', {
      url: trimmedGitUrl,
      branch: gitBranch.trim() || undefined,
    })
  }

  async function queueAction(kind: ActionKind) {
    if (!status.codebaseId) return

    setActionLoading(true)
    try {
      const response = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codebaseId: status.codebaseId, kind }),
      })
      const body = await response.json()
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? 'Action queue failed.')
      }
      setActionError(null)
      await loadActionJobs()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action queue failed.')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <section className="panel-surface overflow-hidden rounded-xl border border-border shadow-sm">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workspace agent</h2>
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize',
                  isBlocked
                    ? 'bg-destructive/10 text-destructive'
                    : isOnline
                      ? 'bg-hop/10 text-hop'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    isBlocked
                      ? 'bg-destructive'
                      : isOnline
                        ? 'bg-hop live-pulse'
                        : 'bg-muted-foreground/60',
                  )}
                />
                {loading ? 'connecting' : status.healthLabel}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {status.id}
            </p>
          </div>
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg',
              isBlocked ? 'bg-destructive/10 text-destructive' : 'bg-hop/10 text-hop',
            )}
          >
            <StatusIcon className="size-4.5" />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
            <FolderOpen className="size-3.5" />
            Workspace root preview
          </p>
          <p className="mt-2 truncate font-mono text-sm font-semibold">
            {status.managedWorkspacePath}
          </p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {privateScopeLabels[status.privateScope]}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <StatusMetric
              icon={Cloud}
              label="Cloud revision"
              value={status.cloudRevision}
            />
            <StatusMetric
              icon={HardDrive}
              label="Hydration"
              value={status.workspaceHydrationState}
              highlight={status.workspaceHydrationState !== 'materialized'}
            />
            <StatusMetric
              icon={FileStack}
              label="Visible files"
              value={status.fileCount.toLocaleString()}
            />
            <StatusMetric
              icon={RotateCcw}
              label="Behind"
              value={
                status.remoteBehindByRevisions === null
                  ? 'unknown'
                  : status.remoteBehindByRevisions.toString()
              }
              highlight={(status.remoteBehindByRevisions ?? 0) > 0}
            />
            <StatusMetric
              icon={UploadCloud}
              label="Pending writes"
              value={status.pendingWrites.toString()}
              highlight={status.pendingWrites > 0}
            />
            <StatusMetric
              icon={Activity}
              label="Local cache"
              value={cacheStateLabels[status.cacheState]}
            />
            <StatusMetric
              icon={Cloud}
              label="Remote update"
              value={status.remoteUpdateState}
              highlight={
                status.remoteUpdateState !== 'idle' &&
                status.remoteUpdateState !== 'Unavailable'
              }
            />
            <StatusMetric
              icon={RotateCcw}
              label="Remote pull"
              value={status.remotePullEnabled ? status.remotePullState : 'disabled'}
              highlight={status.remotePullEnabled && status.remotePullState !== 'enabled'}
            />
            <StatusMetric
              icon={ShieldCheck}
              label="Visibility"
              value={status.visibility}
            />
            <StatusMetric
              icon={GitPullRequest}
              label="Review"
              value={status.reviewState}
              highlight={status.reviewState === 'open'}
            />
            <StatusMetric
              icon={GitMerge}
              label="Merge"
              value={status.mergeState}
              highlight={status.mergeState === 'merged'}
            />
            <StatusMetric
              icon={Activity}
              label="Conflict"
              value={status.conflictState}
              highlight={status.conflictState !== 'none' && status.conflictState !== 'Unavailable'}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <SyncStamp
            icon={RotateCcw}
            label="Last sync"
            value={status.lastSync}
          />
          <SyncStamp
            icon={CheckCircle2}
            label="Last ack"
            value={status.lastAck}
          />
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">Workspace actions</h3>
            {runningCommand ? (
              <span className="text-[10.5px] text-muted-foreground">Running {runningCommand}</span>
            ) : null}
          </div>
          {status.commandsAvailable ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {prototypeActions.map((action) => {
                  const Icon = action.icon
                  const isRunning = runningCommand === action.command
                  const disabledReason = commandDisabledReason(action.command, status, runningCommand)
                  return (
                    <Button
                      key={action.command}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(disabledReason)}
                      title={disabledReason ?? action.label}
                      className="h-8 justify-start gap-1.5 rounded-lg px-2 text-xs"
                      onClick={() => void runCommand(action.command)}
                    >
                      <Icon className={cn('size-3.5 shrink-0', isRunning && 'animate-spin')} />
                      <span className="truncate">{isRunning ? 'Running' : action.label}</span>
                    </Button>
                  )
                })}
              </div>
              <form
                className="mt-3 space-y-2 rounded-lg border border-border/60 bg-background/50 p-2.5"
                onSubmit={submitRemoteImport}
              >
                <label className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Remote Git URL
                </label>
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="h-8 w-full rounded-lg border border-border bg-background px-2.5 font-mono text-xs outline-none transition placeholder:text-muted-foreground/55 focus:border-primary focus:ring-2 focus:ring-primary/20"
                  disabled={Boolean(runningCommand)}
                />
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <input
                    type="text"
                    value={gitBranch}
                    onChange={(event) => setGitBranch(event.target.value)}
                    placeholder="branch"
                    className="h-8 min-w-0 rounded-lg border border-border bg-background px-2.5 font-mono text-xs outline-none transition placeholder:text-muted-foreground/55 focus:border-primary focus:ring-2 focus:ring-primary/20"
                    disabled={Boolean(runningCommand)}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={Boolean(importDisabledReason)}
                    title={importDisabledReason ?? 'Import remote Git URL'}
                    className="h-8 rounded-lg px-2.5 text-xs"
                  >
                    <GitBranch className={cn('size-3.5', importRunning && 'animate-spin')} />
                    <span>{importRunning ? 'Importing' : 'Import'}</span>
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <div className="rounded-lg bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground ring-1 ring-border/50">
              Commands run from the local HopIt agent. This dashboard is currently reading {status.backend}.
            </div>
          )}
          {commandResult ? (
            <div
              className={cn(
                'mt-2.5 rounded-lg p-3 text-[11px] border transition duration-200',
                commandResult.ok
                  ? 'bg-primary/8 text-primary border-primary/20 shadow-sm'
                  : 'bg-destructive/8 text-destructive border-destructive/20 shadow-sm',
              )}
            >
              <p className="font-medium">
                {commandResult.ok ? 'Done' : 'Failed'}: {commandResult.label ?? commandResult.command}
              </p>
              <p className="mt-0.5 line-clamp-2 opacity-80">
                {commandResult.summary ||
                  commandResult.stderr ||
                  commandResult.error?.message ||
                  'No output'}
              </p>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">Hosted actions</h3>
            <span className="text-[10.5px] text-muted-foreground">
              {status.codebaseId ? status.codebaseId : 'No codebase'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <ActionButton
              icon={Terminal}
              label="Lint"
              disabled={actionLoading || !status.codebaseId}
              onClick={() => void queueAction('lint')}
            />
            <ActionButton
              icon={FlaskConical}
              label="Test"
              disabled={actionLoading || !status.codebaseId}
              onClick={() => void queueAction('test')}
            />
            <ActionButton
              icon={Hammer}
              label="Build"
              disabled={actionLoading || !status.codebaseId}
              onClick={() => void queueAction('build')}
            />
          </div>
          {actionError ? (
            <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-2 text-[11px] text-destructive">
              {actionError}
            </div>
          ) : null}
          <ol className="mt-3 space-y-2">
            {actionJobs.slice(0, 4).map((job) => (
              <li key={job.jobId} className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold capitalize">
                    <Play className="size-3 text-primary" />
                    <span className="truncate">{job.kind}</span>
                  </span>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-bold', actionStatusClass(job.status))}>
                    {job.status}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[10.5px] text-muted-foreground">
                  {job.summary ?? actionJobTime(job.updatedAt)}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold">Recent agent events</h3>
            <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <Clock3 className="size-3" />
              Live labels
            </span>
          </div>
          <ol className="space-y-2">
            {status.events.map((event, index) => (
              <motion.li
                key={event.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04, duration: 0.3 }}
                className="rounded-lg border border-border/50 bg-background/50 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={cn(
                      'rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium ring-1 ring-inset',
                      eventToneClasses[event.tone],
                    )}
                  >
                    {event.label}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {event.when}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                  {event.detail}
                </p>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function ActionButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      className="h-8 justify-start gap-1.5 rounded-lg px-2 text-xs"
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  )
}

type StatusMetricProps = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  highlight?: boolean
}

function StatusMetric({ icon: Icon, label, value, highlight = false }: StatusMetricProps) {
  return (
    <div className="min-w-0 rounded-lg bg-card px-3 py-2.5 border border-border/50 shadow-sm hover:border-primary/20 transition duration-200">
      <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">{label}</span>
      </p>
      <p
        className={cn(
          'mt-1.5 truncate text-xs font-bold text-foreground',
          highlight && 'text-hop-amber font-extrabold',
        )}
      >
        {value}
      </p>
    </div>
  )
}

type SyncStampProps = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}

function SyncStamp({ icon: Icon, label, value }: SyncStampProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 shadow-sm">
      <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5 text-primary" />
        {label}
      </p>
      <p className="mt-1 text-xs font-bold text-foreground">{value}</p>
    </div>
  )
}

function commandDisabledReason(
  command: AgentCommand,
  status: AgentStatusSnapshot,
  runningCommand: AgentCommand | null,
) {
  if (runningCommand) return `Running ${runningCommand}`
  if (command === 'review' && status.reviewState === 'open') return 'Review is already open.'
  if (command === 'merge' && status.reviewState !== 'open') return 'Open review before merge.'
  if (command === 'merge' && status.conflictState !== 'none' && status.conflictState !== 'Unavailable') {
    return 'Resolve conflicts before merge.'
  }
  if (command === 'merge' && (status.pendingWrites > 0 || status.failedWrites > 0)) {
    return 'Clear pending or failed writes before merge.'
  }
  return null
}

function remoteImportDisabledReason(
  status: AgentStatusSnapshot,
  runningCommand: AgentCommand | null,
  gitUrl: string,
) {
  if (runningCommand) return `Running ${runningCommand}`
  if (!status.commandsAvailable) return 'Local workspace commands are unavailable.'
  if (!gitUrl) return 'Enter a Git URL.'
  return null
}

function normalizeActionJob(value: unknown): ActionJob {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    jobId: typeof row.jobId === 'string' ? row.jobId : 'unknown',
    kind: row.kind === 'lint' || row.kind === 'test' || row.kind === 'build' ? row.kind : 'build',
    status: typeof row.status === 'string' ? row.status : 'queued',
    summary: typeof row.summary === 'string' ? row.summary : null,
    exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  }
}

function actionStatusClass(status: string) {
  if (status === 'succeeded') return 'bg-primary/10 text-primary'
  if (status === 'failed' || status === 'cancelled') return 'bg-destructive/10 text-destructive'
  if (status === 'running') return 'bg-sky-500/10 text-sky-500'
  return 'bg-hop-amber/10 text-hop-amber'
}

function actionJobTime(value: string) {
  if (!value) return 'Waiting for a hosted runner.'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Waiting for a hosted runner.'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}
