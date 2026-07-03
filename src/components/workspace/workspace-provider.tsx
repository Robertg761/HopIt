'use client'

import * as React from 'react'
import {
  type AgentStatusSnapshot,
  mapAgentStatusResponse,
  offlineAgentStatus,
} from '@/lib/client/agent-status'
import { humanizeApiError } from '@/lib/client/errors'

const LOCAL_POLL_MS = 2500
const HOSTED_POLL_MS = 30_000

export type AgentCommand =
  | 'sync'
  | 'refresh'
  | 'recover'
  | 'review'
  | 'merge'
  | 'setupWorkspace'
  | 'attachWorkspace'
  | 'hydrateWorkspace'
  | 'hydratePath'
  | 'pruneWorkspace'
  | 'pinPath'
  | 'unpinPath'
  | 'dehydrateWorkspace'
  | 'importGitUrl'

export type AgentCommandPayload = {
  codebaseId?: string | null
  url?: string
  branch?: string
  path?: string
  recursive?: boolean
  execute?: boolean
  inactiveMs?: number
}

export type AgentCommandResult = {
  ok: boolean
  command: AgentCommand
  label?: string
  summary?: string
  stdout?: string
  stderr?: string
  error?: {
    message?: string
  }
}

/** Normalized row from GET /api/codebases, safe to render directly. */
export type CodebaseSummary = {
  id: string
  name: string
  workspacePath: string | null
  attached: boolean
  hydrationState: string
  fileCount: number
  privateFileCount: number
  memberCount: number
  behindByRevisions: number
  visibility: string
  reviewState: string
  mergeState: string
  conflictState: string
  revision: number | null
  updatedAt: string | null
  source: string
}

export type WorkspaceDiscovery = {
  ok: boolean
  rootPath: string | null
  rootExists: boolean
  error: string | null
}

type WorkspaceContextValue = {
  status: AgentStatusSnapshot
  loading: boolean
  selectedCodebaseId: string | null
  selectCodebase: (codebaseId: string) => void
  refresh: () => Promise<void>
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
  codebases: CodebaseSummary[]
  codebasesLoading: boolean
  codebasesError: string | null
  workspaceDiscovery: WorkspaceDiscovery | null
  refreshCodebases: () => Promise<void>
  hasWorkspace: boolean
  actorId: string
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
  const value = React.useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return value
}

export function WorkspaceProvider({
  initialCodebaseId = null,
  children,
}: {
  initialCodebaseId?: string | null
  children: React.ReactNode
}) {
  const [status, setStatus] = React.useState<AgentStatusSnapshot>(() =>
    offlineAgentStatus('Connecting to the HopIt agent.'),
  )
  const [loading, setLoading] = React.useState(true)
  const [selectedCodebaseId, setSelectedCodebaseId] = React.useState<string | null>(initialCodebaseId)
  const [runningCommand, setRunningCommand] = React.useState<AgentCommand | null>(null)
  const [commandResult, setCommandResult] = React.useState<AgentCommandResult | null>(null)
  const [codebases, setCodebases] = React.useState<CodebaseSummary[]>([])
  const [codebasesLoading, setCodebasesLoading] = React.useState(true)
  const [codebasesError, setCodebasesError] = React.useState<string | null>(null)
  const [workspaceDiscovery, setWorkspaceDiscovery] = React.useState<WorkspaceDiscovery | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const statusUrl = selectedCodebaseId
        ? `/api/agent/status?codebaseId=${encodeURIComponent(selectedCodebaseId)}`
        : '/api/agent/status'
      const response = await fetch(statusUrl, { cache: 'no-store' })
      const body = await response.json()
      const nextStatus = mapAgentStatusResponse(body)

      setStatus(nextStatus)
      if (!selectedCodebaseId && nextStatus.codebaseId) setSelectedCodebaseId(nextStatus.codebaseId)
    } catch (error) {
      setStatus(offlineAgentStatus(error instanceof Error ? error.message : 'Agent status request failed.'))
    } finally {
      setLoading(false)
    }
  }, [selectedCodebaseId])

  const refreshCodebases = React.useCallback(async () => {
    try {
      const response = await fetch('/api/codebases', { cache: 'no-store' })
      const body = (await response.json()) as Record<string, unknown>
      if (body && body.ok === false) {
        const error = asRecord(body.error)
        setCodebasesError(
          humanizeApiError(typeof error?.message === 'string' ? error.message : 'Codebase list unavailable.'),
        )
      } else {
        setCodebasesError(null)
      }
      setCodebases(normalizeCodebases(body?.codebases))
      setWorkspaceDiscovery(normalizeDiscovery(body?.workspaceDiscovery))
    } catch (error) {
      setCodebasesError(
        humanizeApiError(error instanceof Error ? error.message : 'Codebase list request failed.'),
      )
    } finally {
      setCodebasesLoading(false)
    }
  }, [])

  const runCommand = React.useCallback(
    async (command: AgentCommand, payload: AgentCommandPayload = {}) => {
      if (!status.commandsAvailable) {
        const result: AgentCommandResult = {
          ok: false,
          command,
          stderr: 'Workspace commands are only available from the local HopIt agent.',
        }
        setCommandResult(result)
        return result
      }

      setRunningCommand(command)
      try {
        const response = await fetch('/api/agent/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, codebaseId: selectedCodebaseId ?? status.codebaseId, ...payload }),
        })
        const result = (await response.json()) as AgentCommandResult
        const nextResult = { ...result, command }
        setCommandResult(nextResult)
        return nextResult
      } catch (error) {
        const result: AgentCommandResult = {
          ok: false,
          command,
          stderr: error instanceof Error ? error.message : 'Agent command failed.',
        }
        setCommandResult(result)
        return result
      } finally {
        setRunningCommand(null)
        await refresh()
        void refreshCodebases()
      }
    },
    [refresh, refreshCodebases, selectedCodebaseId, status.codebaseId, status.commandsAvailable],
  )

  React.useEffect(() => {
    let cancelled = false
    const load = () => {
      if (!cancelled) void refresh()
    }
    load()
    const interval = window.setInterval(
      load,
      status.backend === 'd1' ? HOSTED_POLL_MS : LOCAL_POLL_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refresh, status.backend])

  React.useEffect(() => {
    void refreshCodebases()
  }, [refreshCodebases])

  const hasWorkspace = Boolean(
    status.state !== 'offline' && (status.codebaseId || status.managedWorkspacePath || status.fileCount > 0),
  )

  const value: WorkspaceContextValue = {
    status,
    loading,
    selectedCodebaseId,
    selectCodebase: setSelectedCodebaseId,
    refresh,
    runCommand,
    runningCommand,
    commandResult,
    codebases,
    codebasesLoading,
    codebasesError,
    workspaceDiscovery,
    refreshCodebases,
    hasWorkspace,
    actorId: status.requester.id ?? 'browser-ui',
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeCodebases(value: unknown): CodebaseSummary[] {
  if (!Array.isArray(value)) return []
  const rows: CodebaseSummary[] = []
  for (const entry of value) {
    const row = asRecord(entry)
    const codebase = asRecord(row?.codebase)
    const selectedState = asRecord(row?.selectedState)
    const access = asRecord(row?.access)
    const workspace = asRecord(row?.workspace)
    const remoteUpdate = asRecord(row?.remoteUpdate)
    const id = asString(codebase?.id) ?? asString(row?.id)
    if (!row || !id) continue

    const workspacePath = asString(workspace?.path)
    const attached = row.attached === true || workspace?.attached === true || Boolean(workspacePath)

    rows.push({
      id,
      name: asString(codebase?.name) ?? asString(row.name) ?? id,
      workspacePath,
      attached,
      hydrationState:
        asString(workspace?.hydrationState) ??
        asString(asRecord(workspace?.hydration)?.state) ??
        (attached ? 'attached' : 'cloud-only'),
      fileCount: asNumber(row.fileCount) ?? asNumber(access?.visibleFileCount) ?? 0,
      privateFileCount: asNumber(row.privateFileCount) ?? asNumber(access?.hiddenFileCount) ?? 0,
      memberCount: asNumber(row.memberCount) ?? 0,
      behindByRevisions: asNumber(remoteUpdate?.behindByRevisions) ?? asNumber(row.remoteBehindByRevisions) ?? 0,
      visibility: asString(selectedState?.effectiveVisibility) ?? asString(row.visibility) ?? 'private',
      reviewState: asString(selectedState?.reviewState) ?? 'not-open',
      mergeState: asString(selectedState?.mergeState) ?? 'unmerged',
      conflictState: asString(selectedState?.conflictState) ?? 'none',
      revision: asNumber(row.revision) ?? asNumber(selectedState?.revision),
      updatedAt: asString(row.updatedAt),
      source: asString(row.source) ?? 'cloud',
    })
  }
  return rows
}

function normalizeDiscovery(value: unknown): WorkspaceDiscovery | null {
  const record = asRecord(value)
  if (!record) return null
  const root = asRecord(record.root)
  return {
    ok: record.ok === true,
    rootPath: asString(root?.path),
    rootExists: root?.exists === true,
    error: asString(record.error) ?? asString(asRecord(record.cloud)?.error),
  }
}
