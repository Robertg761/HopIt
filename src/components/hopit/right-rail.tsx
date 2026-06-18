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
  RotateCcw,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type AgentEvent = {
  id: string
  label: string
  detail: string
  when: string
  tone: 'ready' | 'syncing' | 'queued' | 'observed'
}

export type AgentStatusSnapshot = {
  id: string
  status: 'online' | 'syncing' | 'offline'
  managedWorkspacePath: string
  cloudRevision: string
  fileCount: number
  pendingWrites: number
  lastSync: string
  lastAck: string
  cacheState: 'ready' | 'syncing' | 'offline'
  privateScope: 'scoped' | 'none'
  privateScopePath: string
  events: AgentEvent[]
}

const sampleAgentStatus: AgentStatusSnapshot = {
  id: 'local-hopit-agent',
  status: 'online',
  managedWorkspacePath: '~/HopIt/hopit-core',
  cloudRevision: 'cloud-rev 1482',
  fileCount: 184,
  pendingWrites: 2,
  lastSync: '24 sec ago',
  lastAck: '18 sec ago',
  cacheState: 'ready',
  privateScope: 'scoped',
  privateScopePath: '~/HopIt/hopit-core/.private/',
  events: [
    {
      id: 'evt-1',
      label: 'workspace:ready',
      detail: 'Managed workspace folder is available locally',
      when: 'now',
      tone: 'ready',
    },
    {
      id: 'evt-2',
      label: 'private:scoped',
      detail: '.private/ is included as the private workspace scope',
      when: '12 sec',
      tone: 'observed',
    },
    {
      id: 'evt-3',
      label: 'cache:ready',
      detail: 'Local cache matches the latest cloud revision',
      when: '18 sec',
      tone: 'observed',
    },
    {
      id: 'evt-4',
      label: 'writes:pending',
      detail: '2 local edits waiting for upload',
      when: '31 sec',
      tone: 'queued',
    },
    {
      id: 'evt-5',
      label: 'scan:complete',
      detail: '184 files indexed from the managed workspace',
      when: '1 min',
      tone: 'syncing',
    },
  ],
}

const cacheStateLabels: Record<AgentStatusSnapshot['cacheState'], string> = {
  ready: 'Ready',
  syncing: 'Syncing',
  offline: 'Offline',
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
}

export function RightRail() {
  return (
    <aside className="flex flex-col gap-4">
      <AgentStatusPanel status={sampleAgentStatus} />
    </aside>
  )
}

function AgentStatusPanel({ status }: { status: AgentStatusSnapshot }) {
  const isOnline = status.status === 'online'

  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Local agent</h2>
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize',
                  isOnline
                    ? 'bg-hop/10 text-hop'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    isOnline ? 'bg-hop live-pulse' : 'bg-muted-foreground/60',
                  )}
                />
                {status.status}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {status.id}
            </p>
          </div>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hop/10 text-hop">
            <HardDrive className="size-4.5" />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-xl border border-border/60 bg-muted/25 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <FolderOpen className="size-3.5" />
            Managed workspace
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
              icon={FileStack}
              label="Files"
              value={status.fileCount.toLocaleString()}
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
              icon={ShieldCheck}
              label="Private scope"
              value={status.privateScopePath}
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
