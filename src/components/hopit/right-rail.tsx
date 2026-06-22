'use client'

import { motion } from 'framer-motion'
import {
  Activity,
  CheckCircle2,
  Cloud,
  Clock3,
  FileStack,
  FolderOpen,
  HardDrive,
  GitMerge,
  GitPullRequest,
  RotateCcw,
  ShieldCheck,
  UploadCloud,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentStatusSnapshot } from '@/lib/agent-status'
import type { AgentCommand, AgentCommandResult } from '@/hooks/use-agent-status'

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
  ready: 'bg-hop/10 text-hop ring-hop/20',
  syncing: 'bg-sky-500/10 text-sky-500 ring-sky-500/20',
  queued: 'bg-hop-amber/10 text-hop-amber ring-hop-amber/20',
  observed: 'bg-grape/10 text-grape ring-grape/20',
  blocked: 'bg-destructive/10 text-destructive ring-destructive/20',
}

type AgentEvent = AgentStatusSnapshot['events'][number]

type RightRailProps = {
  status: AgentStatusSnapshot
  loading: boolean
  runCommand: (command: AgentCommand) => Promise<void>
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
  runCommand: (command: AgentCommand) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}) {
  const isOnline = status.state === 'online' || status.state === 'syncing'
  const isBlocked = status.state === 'blocked'
  const StatusIcon = status.state === 'offline' ? WifiOff : HardDrive

  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
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
        <div className="rounded-xl border border-border/60 bg-muted/25 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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

        <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">Workspace actions</h3>
            {runningCommand ? (
              <span className="text-[10.5px] text-muted-foreground">Running {runningCommand}</span>
            ) : null}
          </div>
          {status.commandsAvailable ? (
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
          ) : (
            <div className="rounded-lg bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground ring-1 ring-border/50">
              Commands run from the local HopIt agent. This dashboard is currently reading {status.backend}.
            </div>
          )}
          {commandResult ? (
            <div
              className={cn(
                'mt-2 rounded-lg px-2.5 py-2 text-[11px] ring-1 ring-inset',
                commandResult.ok
                  ? 'bg-hop/10 text-hop ring-hop/20'
                  : 'bg-destructive/10 text-destructive ring-destructive/20',
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
                className="rounded-lg border border-border/50 bg-background/45 p-2.5"
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

type StatusMetricProps = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  highlight?: boolean
}

function StatusMetric({ icon: Icon, label, value, highlight = false }: StatusMetricProps) {
  return (
    <div className="min-w-0 rounded-lg bg-card px-2.5 py-2 ring-1 ring-border/50">
      <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </p>
      <p
        className={cn(
          'mt-1 truncate text-[13px] font-semibold',
          highlight && 'text-hop-amber',
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
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Icon className="size-3.5 text-hop" />
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold">{value}</p>
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
