'use client'

import * as React from 'react'
import {
  Activity,
  Bell,
  Braces,
  CheckCircle2,
  Cloud,
  Command,
  Cpu,
  Database,
  EyeOff,
  FileCode2,
  FileStack,
  FolderOpen,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  HardDrive,
  History,
  KeyRound,
  Layers3,
  LockKeyhole,
  MessageSquareText,
  Moon,
  PackageCheck,
  RefreshCcw,
  Search,
  ShieldCheck,
  Sun,
  TerminalSquare,
  UploadCloud,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useTheme } from 'next-themes'

import { ActivityFeed } from '@/website/components/activity-feed'
import { AuthMenu } from '@/website/components/auth-menu'
import { CodeReviewSection } from '@/website/components/code-review-section'
import { CollaborationSection } from '@/website/components/collaboration-section'
import { DriveSection } from '@/website/components/drive-section'
import { HopItLogo } from '@/website/components/logo'
import { MembersInvitationsPanel } from '@/website/components/members-invitations-panel'
import { ReposSection } from '@/website/components/repos-section'
import { RightRail } from '@/website/components/right-rail'
import {
  dashboardSections,
  navigateToSection,
  sectionHref,
} from '@/website/components/navigation'
import {
  type AgentCommand,
  type AgentCommandResult,
  useAgentStatus,
} from '@/website/hooks/use-agent-status'
import type { AgentFile, AgentStatusSnapshot } from '@/website/lib/agent-status'
import { cn } from '@/lib/utils'

type IconComponent = React.ComponentType<{ className?: string }>

const commandActions: Array<{
  command: AgentCommand
  label: string
  icon: IconComponent
}> = [
  { command: 'sync', label: 'Sync', icon: UploadCloud },
  { command: 'refresh', label: 'Refresh', icon: RefreshCcw },
  { command: 'review', label: 'Review', icon: GitPullRequest },
  { command: 'merge', label: 'Merge', icon: GitMerge },
]

const moduleAnchors = [
  { id: 'codebases', label: 'Topology', icon: Layers3 },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'review', label: 'Review', icon: GitPullRequest },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'work-items', label: 'Work', icon: PackageCheck },
  { id: 'activity', label: 'Events', icon: Activity },
  { id: 'status', label: 'Agent', icon: HardDrive },
]

export type HopItDashboardView =
  | 'overview'
  | 'codebases'
  | 'files'
  | 'review'
  | 'members'
  | 'work-items'
  | 'activity'
  | 'status'

type HopItDashboardPageProps = {
  view: HopItDashboardView
}

export function HopItDashboardPage({ view }: HopItDashboardPageProps) {
  const agentStatus = useAgentStatus()
  const { status } = agentStatus

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#page-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg focus:ring-2 focus:ring-hop/40"
      >
        Skip to page content
      </a>

      <div className="command-deck-canvas min-h-screen">
        <TopDock status={status} loading={agentStatus.loading} activeView={view} />

        <main
          id="page-main"
          className="mx-auto flex w-full max-w-[1680px] flex-col gap-5 px-3 py-4 sm:px-4 lg:px-6 lg:py-6"
        >
          <PageContent
            view={view}
            status={status}
            loading={agentStatus.loading}
            refreshStatus={agentStatus.refresh}
            runCommand={agentStatus.runCommand}
            runningCommand={agentStatus.runningCommand}
            commandResult={agentStatus.commandResult}
          />
        </main>

        <Footer />
      </div>
    </div>
  )
}

function PageContent({
  view,
  status,
  loading,
  refreshStatus,
  runCommand,
  runningCommand,
  commandResult,
}: {
  view: HopItDashboardView
  status: AgentStatusSnapshot
  loading: boolean
  refreshStatus: () => Promise<void>
  runCommand: (command: AgentCommand) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}) {
  if (view === 'overview') {
    return (
      <>
        <CommandDeck
          status={status}
          loading={loading}
          runCommand={runCommand}
          runningCommand={runningCommand}
        />
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
          <RepoTopologyPanel status={status} />
          <FileCloudPanel status={status} />
        </section>
        <ReviewLane status={status} />
      </>
    )
  }

  if (view === 'codebases') {
    return (
      <>
        <PageIntro
          eyebrow="Codebases"
          title="Repository topology and connected workspaces"
          description="Browse the live codebase graph, workspace mount, visibility, snapshots, and sync status."
          icon={Layers3}
          status={status}
        />
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
          <RepoTopologyPanel status={status} />
          <ModuleFrame
            eyebrow="Codebase registry"
            title="Connected repositories"
            icon={FolderOpen}
            aside={status.codebaseId ? 'connected' : 'empty'}
          >
            <ReposSection status={status} />
          </ModuleFrame>
        </section>
      </>
    )
  }

  if (view === 'files') {
    return (
      <>
        <PageIntro
          eyebrow="Files"
          title="Cloud files and private workspace contents"
          description="Inspect mounted files, owner-private entries, blob storage state, and import-ready workspace paths."
          icon={FileCode2}
          status={status}
        />
        <section className="grid gap-5 xl:grid-cols-[minmax(380px,0.55fr)_minmax(0,1fr)]">
          <FileCloudPanel status={status} />
          <ModuleFrame
            eyebrow="File browser"
            title="Workspace file explorer"
            icon={FolderOpen}
            aside={`${formatCount(status.fileCount)} files`}
          >
            <DriveSection status={status} />
          </ModuleFrame>
        </section>
      </>
    )
  }

  if (view === 'review') {
    return (
      <>
        <PageIntro
          eyebrow="Review"
          title="Diffs, history, comments, and merge readiness"
          description="Follow the active change-set lane, inspect changed files, and move work toward Main intentionally."
          icon={GitPullRequest}
          status={status}
        />
        <ReviewLane status={status} />
        <ModuleFrame
          eyebrow="Review workspace"
          title="Changed files and review metadata"
          icon={GitPullRequest}
          aside={status.reviewState}
        >
          <CodeReviewSection status={status} />
        </ModuleFrame>
      </>
    )
  }

  if (view === 'members') {
    return (
      <>
        <PageIntro
          eyebrow="Members"
          title="People, invitations, permissions, and encrypted sharing"
          description="Manage who can see a codebase, who can modify it, and which private scopes stay owner-only."
          icon={ShieldCheck}
          status={status}
        />
        <ModuleFrame
          eyebrow="Access plane"
          title="Members, invitations, and encrypted scope"
          icon={ShieldCheck}
          aside={`${status.requester.role} role`}
        >
          <MembersInvitationsPanel
            status={status}
            loading={loading}
            onRefreshStatus={refreshStatus}
          />
        </ModuleFrame>
      </>
    )
  }

  if (view === 'work-items') {
    return (
      <>
        <PageIntro
          eyebrow="Work items"
          title="Issues, discussions, releases, and project flow"
          description="Track product work around real codebase state instead of scattering planning across separate tools."
          icon={MessageSquareText}
          status={status}
        />
        <ModuleFrame
          eyebrow="Collaboration graph"
          title="Issues, discussions, releases, and project flow"
          icon={MessageSquareText}
          aside={status.codebaseName}
        >
          <CollaborationSection status={status} />
        </ModuleFrame>
      </>
    )
  }

  if (view === 'activity') {
    return (
      <>
        <PageIntro
          eyebrow="Activity"
          title="Sync history, review signals, and agent events"
          description="Watch local agent events, cloud sync acknowledgements, remote updates, and collaboration history."
          icon={Activity}
          status={status}
        />
        <ModuleFrame
          eyebrow="Event stream"
          title="Live workspace activity"
          icon={Activity}
          aside={`${status.events.length} signals`}
        >
          <ActivityFeed status={status} />
        </ModuleFrame>
      </>
    )
  }

  return (
    <>
      <PageIntro
        eyebrow="Agent status"
        title="Device sync, remote pull, hydration, and commands"
        description="Control the local HopIt agent, inspect cache state, and verify whether this device is ready to sync."
        icon={TerminalSquare}
        status={status}
      />
      <ModuleFrame
        eyebrow="Agent console"
        title="Device sync and workspace commands"
        icon={TerminalSquare}
        aside={status.commandsAvailable ? 'commands live' : 'read only'}
      >
        <RightRail
          status={status}
          loading={loading}
          runCommand={runCommand}
          runningCommand={runningCommand}
          commandResult={commandResult}
        />
      </ModuleFrame>
    </>
  )
}

function PageIntro({
  eyebrow,
  title,
  description,
  icon: Icon,
  status,
}: {
  eyebrow: string
  title: string
  description: string
  icon: IconComponent
  status: AgentStatusSnapshot
}) {
  return (
    <section className="deck-surface overflow-hidden rounded-lg border border-border/75 bg-card">
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="flex min-w-0 gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md border border-border bg-background text-hop">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="mono-label text-[10px] text-muted-foreground">{eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold leading-tight sm:text-3xl">{title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <StatusPill
            icon={status.state === 'online' || status.state === 'syncing' ? Wifi : WifiOff}
            label={status.healthLabel}
            tone={
              status.state === 'blocked'
                ? 'danger'
                : status.state === 'online' || status.state === 'syncing'
                  ? 'ready'
                  : 'muted'
            }
          />
          <StatusPill
            icon={Cloud}
            label={status.codebaseName}
            tone={status.codebaseId ? 'ready' : 'muted'}
          />
        </div>
      </div>
    </section>
  )
}

function TopDock({
  status,
  loading,
  activeView,
}: {
  status: AgentStatusSnapshot
  loading: boolean
  activeView: HopItDashboardView
}) {
  const { theme, setTheme } = useTheme()
  const activeTheme = theme ?? 'light'
  const online = status.state === 'online' || status.state === 'syncing'
  const blocked = status.state === 'blocked'

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/88 backdrop-blur-xl">
      <div className="mx-auto flex h-auto max-w-[1680px] flex-col gap-2 px-3 py-2 sm:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => navigateToSection('overview')}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition hover:bg-muted/70"
          >
            <HopItLogo size={28} />
            <span className="hidden text-[11px] font-semibold uppercase text-muted-foreground md:inline">
              Source cloud
            </span>
          </button>

          <CommandSearch />

          <div className="hidden items-center gap-2 xl:flex">
            <StatusPill
              icon={online ? Wifi : WifiOff}
              label={loading ? 'connecting' : status.healthLabel}
              tone={blocked ? 'danger' : online ? 'ready' : 'muted'}
            />
            <StatusPill
              icon={ShieldCheck}
              label={status.privateScope === 'scoped' ? 'private scoped' : 'unscoped'}
              tone={status.privateScope === 'scoped' ? 'ready' : 'muted'}
            />
          </div>

          <button
            type="button"
            onClick={() => navigateToSection('activity')}
            className="relative hidden size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-card text-muted-foreground transition hover:border-hop/50 hover:text-foreground sm:grid"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-hop" />
          </button>

          <button
            type="button"
            onClick={() => setTheme(activeTheme === 'dark' ? 'light' : 'dark')}
            className="grid size-9 shrink-0 place-items-center rounded-md border border-border/70 bg-card text-muted-foreground transition hover:border-hop/50 hover:text-foreground"
            aria-label="Toggle theme"
          >
            {activeTheme === 'dark' ? (
              <Sun className="size-4 text-hop-amber" />
            ) : (
              <Moon className="size-4" />
            )}
          </button>

          <AuthMenu />
        </div>

        <nav
          aria-label="Workspace modules"
          className="flex gap-1 overflow-x-auto pb-0.5 scroll-thin"
        >
          {moduleAnchors.map((item) => {
            const Icon = item.icon
            const active = item.id === activeView
            return (
              <a
                key={item.id}
                href={sectionHref(item.id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition hover:border-border hover:bg-card hover:text-foreground',
                  active
                    ? 'border-hop/35 bg-hop/10 text-hop'
                    : 'border-transparent text-muted-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {item.label}
              </a>
            )
          })}
        </nav>
      </div>
    </header>
  )
}

function CommandSearch() {
  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const results = React.useMemo(() => {
    if (!normalizedQuery) return dashboardSections

    return dashboardSections.filter((section) =>
      [section.label, section.description, ...section.keywords]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery])

  React.useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }

      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }

    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function jumpTo(id: string) {
    navigateToSection(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          const first = results[0]
          if (first) jumpTo(first.id)
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search workspaces, files, people"
          className="h-9 w-full rounded-md border border-border/75 bg-card px-9 pr-11 text-sm outline-none transition placeholder:text-muted-foreground/70 focus:border-hop/60 focus:ring-2 focus:ring-hop/18"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
          K
        </span>
      </form>

      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-lg border border-border/80 bg-card shadow-2xl">
          <div className="grid max-h-80 gap-1 overflow-y-auto p-1.5 scroll-thin">
            {results.slice(0, 7).map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => jumpTo(section.id)}
                  className="flex min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left transition hover:bg-muted"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{section.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {section.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function CommandDeck({
  status,
  loading,
  runCommand,
  runningCommand,
}: {
  status: AgentStatusSnapshot
  loading: boolean
  runCommand: (command: AgentCommand) => Promise<void>
  runningCommand: AgentCommand | null
}) {
  const online = status.state === 'online' || status.state === 'syncing'
  const blocked = status.state === 'blocked'
  const healthLabel = loading ? 'Connecting' : status.healthLabel

  const metrics = [
    {
      label: 'Visible files',
      value: formatCount(status.fileCount),
      icon: FileStack,
    },
    {
      label: 'Pending writes',
      value: status.pendingWrites.toString(),
      icon: UploadCloud,
      active: status.pendingWrites > 0,
    },
    {
      label: 'Private entries',
      value: formatCount(status.hiddenFileCount),
      icon: EyeOff,
      active: status.hiddenFileCount > 0,
    },
    {
      label: 'Members',
      value: formatCount(status.members.length),
      icon: Users,
    },
  ]

  return (
    <div className="deck-surface overflow-hidden rounded-lg border border-border/75 shadow-[0_22px_60px_rgba(24,26,23,0.08)]">
      <div className="grid min-h-[460px] lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.42fr)]">
        <div className="relative overflow-hidden bg-ink text-ink-foreground">
          <div className="deck-grid absolute inset-0 opacity-55" />
          <div className="status-scanline absolute inset-x-0 top-0 h-24 opacity-60" />

          <div className="relative flex min-h-full flex-col justify-between gap-8 p-4 sm:p-6 lg:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono-label rounded border border-white/12 bg-white/8 px-2 py-1 text-[10px] text-white/62">
                  Command deck
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-semibold',
                    blocked
                      ? 'border-destructive/40 bg-destructive/15 text-destructive'
                      : online
                        ? 'border-hop/40 bg-hop/16 text-hop'
                        : 'border-white/12 bg-white/8 text-white/64',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      blocked ? 'bg-destructive' : online ? 'bg-hop live-pulse' : 'bg-white/40',
                    )}
                  />
                  {healthLabel}
                </span>
              </div>

              <div className="min-w-44 rounded-md border border-white/12 bg-white/8 p-3 backdrop-blur">
                <p className="mono-label text-[10px] text-white/52">Active change set</p>
                <p className="mt-1 truncate font-mono text-sm font-semibold">
                  {status.activeChangeSetId}
                </p>
                <p className="mt-1 truncate text-[11px] text-white/54">
                  main {status.mainRevision}
                </p>
              </div>
            </div>

            <div className="max-w-4xl">
              <p className="mono-label text-[11px] text-hop-amber">
                HopIt private source cloud
              </p>
              <h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-[1.02] tracking-normal sm:text-5xl lg:text-6xl">
                Code, files, review, and sync in one live workspace.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-white/68 sm:text-base">
                {status.codebaseName === 'No codebase'
                  ? 'No managed workspace is connected on this device yet.'
                  : `${status.codebaseName} is mounted as a cloud-backed workspace with local agent state.`}
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {metrics.map((metric) => {
                  const Icon = metric.icon
                  return (
                    <div
                      key={metric.label}
                      className="rounded-md border border-white/10 bg-white/[0.07] p-3"
                    >
                      <div className="flex items-center gap-2 text-white/54">
                        <Icon
                          className={cn(
                            'size-3.5',
                            metric.active ? 'text-hop-amber' : 'text-white/48',
                          )}
                        />
                        <span className="mono-label text-[10px]">{metric.label}</span>
                      </div>
                      <p className="mt-2 text-2xl font-semibold">{metric.value}</p>
                    </div>
                  )
                })}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex">
                {commandActions.map((action) => {
                  const Icon = action.icon
                  const running = runningCommand === action.command
                  return (
                    <button
                      key={action.command}
                      type="button"
                      disabled={!status.commandsAvailable || Boolean(runningCommand)}
                      onClick={() => void runCommand(action.command)}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/12 bg-white/9 px-3 text-sm font-semibold text-white transition hover:border-hop/50 hover:bg-hop/15 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Icon className={cn('size-4', running && 'animate-spin')} />
                      {action.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        <aside className="grid border-t border-border/70 bg-card lg:border-l lg:border-t-0">
          <DeckSignal
            icon={Cloud}
            label="Graph backend"
            value={status.backend}
            detail={`cloud rev ${status.cloudRevision}`}
          />
          <DeckSignal
            icon={ShieldCheck}
            label="Privacy"
            value={status.privateScope === 'scoped' ? 'Scoped' : 'Unscoped'}
            detail={status.privateScopePath}
            active={status.privateScope === 'scoped'}
          />
          <DeckSignal
            icon={RefreshCcw}
            label="Remote pull"
            value={status.remotePullEnabled ? status.remotePullState : 'Disabled'}
            detail={status.remoteBehindByRevisions === null ? 'behind unknown' : `${status.remoteBehindByRevisions} behind`}
            active={status.remotePullEnabled}
          />
          <DeckSignal
            icon={GitPullRequest}
            label="Review state"
            value={status.reviewState}
            detail={`merge ${status.mergeState}`}
          />
        </aside>
      </div>
    </div>
  )
}

function DeckSignal({
  icon: Icon,
  label,
  value,
  detail,
  active,
}: {
  icon: IconComponent
  label: string
  value: string
  detail: string
  active?: boolean
}) {
  return (
    <div className="grid min-h-[112px] grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-border/70 p-4 last:border-b-0">
      <span
        className={cn(
          'grid size-9 place-items-center rounded-md border',
          active
            ? 'border-hop/35 bg-hop/10 text-hop'
            : 'border-border bg-muted/45 text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="mono-label text-[10px] text-muted-foreground">{label}</span>
        <span className="mt-1 block truncate text-lg font-semibold capitalize">{value}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </div>
  )
}

function RepoTopologyPanel({ status }: { status: AgentStatusSnapshot }) {
  const fileDirectories = directoryCount(status.files)
  const nodes = [
    {
      label: 'Local device',
      value: status.cacheState,
      icon: HardDrive,
      className: 'left-[6%] top-[24%]',
    },
    {
      label: 'Active change set',
      value: compactValue(status.activeChangeSetId),
      icon: GitCommitHorizontal,
      className: 'left-[35%] top-[42%]',
      primary: true,
    },
    {
      label: 'Cloud graph',
      value: `rev ${status.cloudRevision}`,
      icon: Database,
      className: 'right-[8%] top-[18%]',
    },
    {
      label: 'Main',
      value: `rev ${status.mainRevision}`,
      icon: GitMerge,
      className: 'right-[14%] bottom-[16%]',
    },
    {
      label: '.private',
      value: `${formatCount(status.hiddenFileCount)} hidden`,
      icon: LockKeyhole,
      className: 'left-[16%] bottom-[12%]',
      privateNode: true,
    },
  ]

  return (
    <section
      id="codebases"
      className="deck-surface scroll-mt-24 overflow-hidden rounded-lg border border-border/75 bg-card"
    >
      <ModuleHeader
        eyebrow="Repo topology"
        title={status.codebaseName}
        icon={Layers3}
        aside={status.codebaseId ? 'connected' : 'no codebase'}
      />

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:p-5">
        <div className="topology-field relative min-h-[360px] overflow-hidden rounded-md border border-border/70 bg-muted/20">
          <div className="topology-grid absolute inset-0" />
          <div className="absolute left-[15%] top-[34%] h-px w-[60%] rotate-[9deg] bg-border" />
          <div className="absolute left-[31%] top-[54%] h-px w-[44%] -rotate-[22deg] bg-border" />
          <div className="absolute left-[22%] top-[62%] h-px w-[28%] rotate-[-8deg] bg-border" />

          {nodes.map((node) => {
            const Icon = node.icon
            return (
              <div
                key={node.label}
                className={cn(
                  'absolute w-[180px] max-w-[42%] rounded-md border bg-card/94 p-3 shadow-lg backdrop-blur',
                  node.primary
                    ? 'border-hop/55 shadow-hop/10'
                    : node.privateNode
                      ? 'border-hop-amber/45'
                      : 'border-border/80',
                  node.className,
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-md',
                      node.primary
                        ? 'bg-hop/12 text-hop'
                        : node.privateNode
                          ? 'bg-hop-amber/12 text-hop-amber'
                          : 'bg-secondary text-secondary-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="mono-label block truncate text-[10px] text-muted-foreground">
                      {node.label}
                    </span>
                    <span className="block truncate text-sm font-semibold">{node.value}</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        <div className="grid gap-3">
          <TopologyStat label="Workspace" value={status.managedWorkspacePath} icon={FolderOpen} />
          <TopologyStat label="Directories" value={formatCount(fileDirectories)} icon={Braces} />
          <TopologyStat label="Hydration" value={status.workspaceHydrationState} icon={Cloud} />
          <TopologyStat label="Conflict" value={status.conflictState} icon={CheckCircle2} />
        </div>
      </div>
    </section>
  )
}

function TopologyStat({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: IconComponent
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-3.5" />
        <span className="mono-label text-[10px]">{label}</span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold">{value}</p>
    </div>
  )
}

function FileCloudPanel({ status }: { status: AgentStatusSnapshot }) {
  const files = status.files.slice(0, 6)
  const totalBytes = status.files.reduce((sum, file) => sum + (file.size ?? 0), 0)
  const privateCount = status.files.filter((file) => file.scope === 'owner-private').length

  return (
    <section
      id="files"
      className="deck-surface scroll-mt-24 overflow-hidden rounded-lg border border-border/75 bg-card"
    >
      <ModuleHeader
        eyebrow="Cloud files"
        title="File graph"
        icon={FileCode2}
        aside={`${formatCount(status.fileCount)} visible`}
      />

      <div className="grid gap-4 p-4 lg:p-5">
        <div className="grid grid-cols-3 gap-2">
          <MiniMetric label="Bytes" value={formatBytes(totalBytes)} icon={Database} />
          <MiniMetric label="Private" value={formatCount(privateCount)} icon={KeyRound} />
          <MiniMetric label="Writes" value={status.pendingWrites.toString()} icon={UploadCloud} />
        </div>

        <div className="rounded-md border border-border/70 bg-background/65">
          <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
            <span className="mono-label text-[10px] text-muted-foreground">Mounted entries</span>
            <span className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {status.visibility}
            </span>
          </div>

          <div className="divide-y divide-border/65">
            {files.length > 0 ? (
              files.map((file) => <FileRow key={file.path} file={file} />)
            ) : (
              <div className="grid min-h-[214px] place-items-center px-4 py-8 text-center">
                <div>
                  <Cloud className="mx-auto size-8 text-muted-foreground/55" />
                  <p className="mt-3 text-sm font-semibold">No file graph mounted</p>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                    Start the local agent to populate cloud entries, private scope, and sync state.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function MiniMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: IconComponent
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background/70 p-3">
      <Icon className="size-3.5 text-hop" />
      <p className="mono-label mt-2 text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  )
}

function FileRow({ file }: { file: AgentFile }) {
  const Icon = file.kind === 'directory' ? FolderOpen : file.kind === 'symlink' ? GitCommitHorizontal : FileCode2

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
      <span className="grid size-8 place-items-center rounded-md bg-secondary text-secondary-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{file.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{file.directory || './'}</span>
      </span>
      <span
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px]',
          file.scope === 'owner-private'
            ? 'border-hop-amber/35 bg-hop-amber/10 text-hop-amber'
            : 'border-border bg-card text-muted-foreground',
        )}
      >
        {file.scope === 'owner-private' ? 'private' : formatBytes(file.size)}
      </span>
    </div>
  )
}

function ReviewLane({ status }: { status: AgentStatusSnapshot }) {
  const steps = [
    {
      label: 'Device',
      value: status.cacheState,
      icon: HardDrive,
      active: status.cacheState === 'ready' || status.cacheState === 'syncing',
    },
    {
      label: 'Change set',
      value: compactValue(status.activeChangeSetId),
      icon: GitCommitHorizontal,
      active: status.activeChangeSetId !== 'No active change set',
    },
    {
      label: 'Review',
      value: status.reviewState,
      icon: GitPullRequest,
      active: status.reviewState === 'open',
    },
    {
      label: 'Main',
      value: status.mainRevision,
      icon: GitMerge,
      active: status.mergeState === 'merged',
    },
    {
      label: 'Devices',
      value: status.remotePullEnabled ? status.remotePullState : 'disabled',
      icon: Cpu,
      active: status.remotePullEnabled,
    },
  ]

  return (
    <section
      id="review"
      className="deck-surface scroll-mt-24 overflow-hidden rounded-lg border border-border/75 bg-card"
    >
      <ModuleHeader
        eyebrow="Change lane"
        title="Review, history, and merge state"
        icon={GitPullRequest}
        aside={status.mergeState}
      />

      <div className="grid gap-4 p-4 lg:p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="overflow-x-auto rounded-md border border-border/70 bg-background/65 p-4 scroll-thin">
          <div className="grid min-w-[760px] grid-cols-5 gap-3">
            {steps.map((step, index) => {
              const Icon = step.icon
              return (
                <div key={step.label} className="relative">
                  {index < steps.length - 1 && (
                    <div className="absolute left-[calc(50%+1.5rem)] right-[-1.5rem] top-5 h-px bg-border" />
                  )}
                  <div
                    className={cn(
                      'relative rounded-md border bg-card p-3',
                      step.active ? 'border-hop/45 shadow-sm shadow-hop/10' : 'border-border/75',
                    )}
                  >
                    <span
                      className={cn(
                        'grid size-10 place-items-center rounded-md',
                        step.active ? 'bg-hop/12 text-hop' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <p className="mono-label mt-4 text-[10px] text-muted-foreground">{step.label}</p>
                    <p className="mt-1 truncate text-sm font-semibold capitalize">{step.value}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="grid gap-3">
          <ReviewSignal label="Last sync" value={status.lastSync} icon={History} />
          <ReviewSignal label="Acknowledged" value={status.lastAck} icon={CheckCircle2} />
          <ReviewSignal label="Remote update" value={status.remoteUpdateState} icon={RefreshCcw} />
          <ReviewSignal label="Failed writes" value={status.failedWrites.toString()} icon={WifiOff} />
        </div>
      </div>
    </section>
  )
}

function ReviewSignal({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: IconComponent
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border border-border/70 bg-background/70 p-3">
      <span className="grid size-8 place-items-center rounded-md bg-secondary text-secondary-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="mono-label block text-[10px] text-muted-foreground">{label}</span>
        <span className="mt-1 block truncate text-sm font-semibold">{value}</span>
      </span>
    </div>
  )
}

function ModuleFrame({
  eyebrow,
  title,
  icon,
  aside,
  children,
}: {
  eyebrow: string
  title: string
  icon: IconComponent
  aside: string
  children: React.ReactNode
}) {
  return (
    <section className="deck-surface overflow-hidden rounded-lg border border-border/75 bg-card">
      <ModuleHeader eyebrow={eyebrow} title={title} icon={icon} aside={aside} />
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  )
}

function ModuleHeader({
  eyebrow,
  title,
  icon: Icon,
  aside,
}: {
  eyebrow: string
  title: string
  icon: IconComponent
  aside: string
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-card/75 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-background text-hop">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="mono-label text-[10px] text-muted-foreground">{eyebrow}</p>
          <h2 className="truncate text-base font-semibold">{title}</h2>
        </div>
      </div>
      <span className="hidden shrink-0 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground sm:block">
        {aside}
      </span>
    </div>
  )
}

function StatusPill({
  icon: Icon,
  label,
  tone,
}: {
  icon: IconComponent
  label: string
  tone: 'ready' | 'danger' | 'muted'
}) {
  return (
    <span
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-md border px-2.5 text-xs font-semibold capitalize',
        tone === 'ready'
          ? 'border-hop/35 bg-hop/10 text-hop'
          : tone === 'danger'
            ? 'border-destructive/35 bg-destructive/10 text-destructive'
            : 'border-border bg-card text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

function Footer() {
  return (
    <footer className="mt-4 border-t border-border/70 bg-background/80">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 py-6 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between lg:px-6">
        <div className="flex items-center gap-3">
          <HopItLogo size={24} />
          <span>© {new Date().getFullYear()} HopIt Labs</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <Cloud className="size-3.5 text-hop" />
            Source cloud
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-hop-amber" />
            Private by default
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Command className="size-3.5 text-grape" />
            Command driven
          </span>
        </div>
      </div>
    </footer>
  )
}

function directoryCount(files: AgentFile[]) {
  return new Set(files.map((file) => file.directory).filter(Boolean)).size
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US', { notation: value >= 10000 ? 'compact' : 'standard' }).format(value)
}

function formatBytes(value: number | null | undefined) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function compactValue(value: string) {
  if (value.length <= 26) return value
  return `${value.slice(0, 12)}...${value.slice(-8)}`
}
