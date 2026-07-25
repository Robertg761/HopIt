'use client'

import * as React from 'react'
import { ArrowRight, CheckCircle2, Clock3, Laptop, LoaderCircle, Plus, ShieldCheck, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  deviceBatchApprovalGate,
  normalizeDeviceCodebaseOptions,
  type DeviceCodebaseOption,
  type DeviceProjectSelection,
  type DeviceRequestedProject,
} from './codebase-options'

type DeviceInfo = {
  id?: string | null
  name?: string | null
  platform?: string | null
}

type SelectionState = Record<string, DeviceProjectSelection & { overrideOpen: boolean }>

export function DeviceApproval({
  userCode,
  initialStatus,
  device,
  expiresAt,
  codebases,
  requestedProjects,
}: {
  userCode: string
  initialStatus: string
  device: DeviceInfo
  expiresAt: string
  codebases: Array<{ id: string; name: string }>
  requestedProjects: DeviceRequestedProject[]
}) {
  const [availableCodebases, setAvailableCodebases] = React.useState<DeviceCodebaseOption[]>(codebases)
  const existingIds = React.useMemo(
    () => availableCodebases.map((option) => option.id),
    [availableCodebases],
  )

  // A requested project that does not exist yet starts with NO resolved target.
  // Pre-selecting an existing project here is exactly the failure that let a
  // single click connect a device to the wrong project, so a row stays
  // un-approvable until it is either created or deliberately pointed elsewhere.
  const [selections, setSelections] = React.useState<SelectionState>(() => {
    const initial: SelectionState = {}
    for (const project of requestedProjects) {
      const exists = codebases.some((option) => option.id === project.id)
      initial[project.id] = {
        requested: project,
        selected: true,
        resolvedCodebaseId: exists ? project.id : '',
        acknowledgedExisting: false,
        overrideOpen: false,
      }
    }
    return initial
  })

  // Used only when the terminal named no project at all (plain `hop setup`).
  const [singleCodebaseId, setSingleCodebaseId] = React.useState(codebases[0]?.id ?? '')
  const [newCodebaseName, setNewCodebaseName] = React.useState('')
  const [status, setStatus] = React.useState(initialStatus)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [creating, setCreating] = React.useState<string[]>([])

  const isBatch = requestedProjects.length > 0
  const rows = React.useMemo(
    () => requestedProjects.map((project) => selections[project.id]).filter(Boolean),
    [requestedProjects, selections],
  )
  const gate = deviceBatchApprovalGate({
    selections: isBatch
      ? rows
      : [{
          requested: { id: singleCodebaseId, name: singleCodebaseId },
          selected: Boolean(singleCodebaseId),
          resolvedCodebaseId: singleCodebaseId,
          acknowledgedExisting: false,
        }],
    existingCodebaseIds: existingIds,
    busy,
  })
  const pendingCreates = rows.filter((row) => row.selected && !existingIds.includes(row.requested.id))

  function updateRow(requestedId: string, patch: Partial<SelectionState[string]>) {
    setSelections((current) => ({ ...current, [requestedId]: { ...current[requestedId], ...patch } }))
  }

  function applyCreatedOptions(options: DeviceCodebaseOption[]) {
    setAvailableCodebases((current) => {
      const merged = [...current]
      for (const option of options) {
        if (!merged.some((entry) => entry.id === option.id)) merged.push(option)
      }
      return merged
    })
  }

  /** Create one project, optionally with the exact id the terminal requested. */
  async function createCodebase(name: string, desiredId?: string | null) {
    const trimmedName = name.trim()
    if (!trimmedName) return null
    const response = await fetch('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(desiredId ? { name: trimmedName, codebaseId: desiredId } : { name: trimmedName }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error?.message ?? 'Project creation failed.')
    }
    const options = normalizeDeviceCodebaseOptions(body.codebases)
    if (options.length === 0) throw new Error('The project was created, but it could not be selected.')
    applyCreatedOptions(options)
    return normalizeDeviceCodebaseOptions([body.codebase])[0]?.id ?? null
  }

  async function createRequested(project: DeviceRequestedProject) {
    if (creating.includes(project.id)) return
    setCreating((current) => [...current, project.id])
    setError(null)
    try {
      const createdId = await createCodebase(project.name, project.id)
      updateRow(project.id, {
        resolvedCodebaseId: createdId ?? project.id,
        overrideOpen: false,
        acknowledgedExisting: false,
      })
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : 'Project creation failed.')
    } finally {
      setCreating((current) => current.filter((id) => id !== project.id))
    }
  }

  // Bulk create is offered only for rows that will CREATE the requested project.
  // Adopting an existing project is never part of a bulk action.
  async function createAllRequested() {
    for (const row of pendingCreates) {
      // Sequential rather than a burst of parallel project-creation writes.
      // createRequested swallows its own error, so one failure leaves that row
      // un-created (and therefore un-approvable, per the gate) while the rest
      // still get made. Partial progress beats losing the whole batch.
      await createRequested(row.requested)
    }
  }

  async function createFirstCodebase() {
    if (creating.length > 0) return
    setCreating(['__single__'])
    setError(null)
    try {
      const createdId = await createCodebase(newCodebaseName)
      if (createdId) setSingleCodebaseId(createdId)
      setNewCodebaseName('')
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : 'Project creation failed.')
    } finally {
      setCreating([])
    }
  }

  async function approve() {
    if (!gate.canApprove) return
    setBusy(true)
    setError(null)
    try {
      const payload = isBatch
        ? rows.filter((row) => row.selected).map((row) => ({
            codebaseId: row.resolvedCodebaseId,
            requestedCodebaseId: row.requested.id,
            acknowledgedExisting: row.acknowledgedExisting,
          }))
        : [{ codebaseId: singleCodebaseId, requestedCodebaseId: null, acknowledgedExisting: false }]
      const response = await fetch('/api/device-authorizations/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode, selections: payload }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error?.message ?? 'Device approval failed.')
      }
      setStatus('approved')
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Device approval failed.')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'approved') {
    return (
      <div className="px-6 py-8 sm:px-8 sm:py-10">
        <div className="mb-5 flex size-12 items-center justify-center rounded-full bg-[#dafbe1] text-[#116329]">
          <CheckCircle2 className="size-7" aria-hidden="true" />
        </div>
        <h2 className="text-xl font-semibold tracking-[-0.02em]">
          {gate.selectedCount > 1 ? `${gate.selectedCount} projects connected` : 'Device connected'}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-[#5d6a62]">
          Return to your terminal. HopIt is finishing the workspace and service setup now.
        </p>
        <div className="mt-6 rounded-xl border border-[#b7dfc1] bg-[#f0fff4] px-4 py-3 font-mono text-xs text-[#116329]">
          Safe to close this window
        </div>
      </div>
    )
  }

  if (status !== 'pending') {
    return (
      <div className="px-6 py-8 sm:px-8">
        <div className="flex items-start gap-3 rounded-xl border border-[#eed49b] bg-[#fffaf0] p-4 text-[#7d4e00]">
          <Clock3 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">This authorization is {status}</p>
            <p className="mt-1 text-xs leading-5">
              Links are single-use and expire about 10 minutes after they are created. If you re-ran hop setup or hop add,
              a newer tab was opened. Close this one and use the most recent tab, or run the command again in your
              terminal to get a fresh link.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-6 sm:px-8 sm:py-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <Detail label="Device" value={device.name ?? 'New device'} icon={<Laptop className="size-4" />} />
        <Detail label="Platform" value={device.platform ?? 'Unknown'} icon={<ShieldCheck className="size-4" />} />
      </div>

      <div className="my-6 h-px bg-[#e1e8e3]" />

      {isBatch ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#637067]">
              Project access
            </span>
            <span className="text-xs text-[#66736b]">
              {gate.selectedCount} of {rows.length} selected
            </span>
          </div>

          {rows.length > 1 ? (
            <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold">
              <button
                type="button"
                className="text-[#1a7f37] underline underline-offset-2"
                onClick={() => setSelections((current) => {
                  const next = { ...current }
                  for (const key of Object.keys(next)) next[key] = { ...next[key], selected: true }
                  return next
                })}
              >
                Select all
              </button>
              <button
                type="button"
                className="text-[#66736b] underline underline-offset-2"
                onClick={() => setSelections((current) => {
                  const next = { ...current }
                  for (const key of Object.keys(next)) next[key] = { ...next[key], selected: false }
                  return next
                })}
              >
                Clear
              </button>
            </div>
          ) : null}

          <ul className="mt-3 space-y-2">
            {rows.map((row) => {
              const exists = existingIds.includes(row.requested.id)
              const adopting = Boolean(row.resolvedCodebaseId) && row.resolvedCodebaseId !== row.requested.id
              const isCreating = creating.includes(row.requested.id)
              return (
                <li
                  key={row.requested.id}
                  className={`rounded-xl border p-3 transition ${
                    adopting ? 'border-[#e4b9bd] bg-[#fff5f5]' : 'border-[#dce5df] bg-[#fbfcfb]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-[#1a7f37]"
                      checked={row.selected}
                      aria-label={`Connect ${row.requested.name}`}
                      onChange={(event) => updateRow(row.requested.id, { selected: event.target.checked })}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[#17211b]" title={row.requested.name}>
                        {row.requested.name}
                      </span>
                      <span className="block font-mono text-[11px] text-[#5d6a62]">{row.requested.id}</span>
                    </div>
                    {exists ? (
                      <span className="shrink-0 rounded-full bg-[#dafbe1] px-2 py-0.5 text-[11px] font-semibold text-[#116329]">
                        Ready
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        className="shrink-0 bg-[#1a7f37] text-white hover:bg-[#116329]"
                        disabled={isCreating}
                        onClick={() => void createRequested(row.requested)}
                      >
                        {isCreating ? <LoaderCircle className="animate-spin" /> : <Plus />}
                        {isCreating ? 'Creating…' : 'Create'}
                      </Button>
                    )}
                  </div>

                  {row.selected ? (
                    <div className="mt-2 pl-7">
                      {!row.overrideOpen ? (
                        <button
                          type="button"
                          className="text-[11px] font-semibold text-[#a40e26] underline underline-offset-2"
                          onClick={() => updateRow(row.requested.id, { overrideOpen: true })}
                        >
                          Use an existing project instead…
                        </button>
                      ) : (
                        <div className="rounded-lg border border-[#e4b9bd] bg-white p-3">
                          <p className="flex items-start gap-2 text-[11px] leading-5 text-[#7d2b34]">
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            <span>
                              Your terminal asked for <span className="font-mono font-semibold">{row.requested.id}</span>.
                              Pointing it at a different existing project makes this device operate on that project, and
                              its managed workspace can be overwritten by the import.
                            </span>
                          </p>
                          <select
                            value={adopting ? row.resolvedCodebaseId : ''}
                            aria-label={`Existing project for ${row.requested.name}`}
                            onChange={(event) => updateRow(row.requested.id, {
                              resolvedCodebaseId: event.target.value,
                              acknowledgedExisting: false,
                            })}
                            className="mt-2 h-10 w-full rounded-lg border border-[#e4b9bd] bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-[#a40e26] focus:ring-4 focus:ring-[#a40e26]/10"
                          >
                            <option value="">Select a project…</option>
                            {availableCodebases.map((codebase) => (
                              <option key={codebase.id} value={codebase.id}>{codebase.name}</option>
                            ))}
                          </select>
                          {adopting ? (
                            <label className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-[#7d2b34]">
                              <input
                                type="checkbox"
                                className="mt-0.5 size-4 shrink-0 accent-[#a40e26]"
                                checked={row.acknowledgedExisting}
                                onChange={(event) => updateRow(row.requested.id, {
                                  acknowledgedExisting: event.target.checked,
                                })}
                              />
                              <span>
                                I understand this device asked for{' '}
                                <span className="font-mono font-semibold">{row.requested.id}</span> and will instead
                                operate on <span className="font-mono font-semibold">{row.resolvedCodebaseId}</span>.
                              </span>
                            </label>
                          ) : null}
                          <button
                            type="button"
                            className="mt-2 text-[11px] font-medium text-[#66736b] underline underline-offset-2"
                            onClick={() => updateRow(row.requested.id, {
                              overrideOpen: false,
                              acknowledgedExisting: false,
                              resolvedCodebaseId: exists ? row.requested.id : '',
                            })}
                          >
                            Cancel and use {row.requested.id} instead
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {pendingCreates.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full border-[#b7dfc1] bg-[#f0fff4] text-[#116329] hover:bg-[#dafbe1]"
              disabled={creating.length > 0}
              onClick={() => void createAllRequested()}
            >
              {creating.length > 0 ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {creating.length > 0 ? 'Creating…' : `Create all ${pendingCreates.length} new projects`}
            </Button>
          ) : null}
        </div>
      ) : availableCodebases.length > 0 ? (
        <label className="block">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#637067]">Project access</span>
          <select
            value={singleCodebaseId}
            onChange={(event) => setSingleCodebaseId(event.target.value)}
            className="mt-2 h-11 w-full rounded-lg border border-[#bac8bf] bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-[#1a7f37] focus:ring-4 focus:ring-[#1a7f37]/10"
          >
            {availableCodebases.map((codebase) => (
              <option key={codebase.id} value={codebase.id}>{codebase.name}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="rounded-xl border border-[#cbd8cf] bg-[#f7faf8] p-4">
          <p className="text-sm font-semibold text-[#26362c]">Create your first project</p>
          <p className="mt-1 text-xs leading-5 text-[#66736b]">
            This gives the new device a cloud workspace to attach before setup returns to your terminal.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={newCodebaseName}
              onChange={(event) => setNewCodebaseName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createFirstCodebase()
                }
              }}
              placeholder="My project"
              aria-label="New project name"
              className="border-[#bac8bf] bg-white text-[#17211b]"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-[#bac8bf] bg-white text-[#17211b] hover:bg-[#eef5f0]"
              disabled={!newCodebaseName.trim() || creating.length > 0}
              onClick={() => void createFirstCodebase()}
            >
              {creating.length > 0 ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {creating.length > 0 ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 rounded-xl border border-[#dce5df] bg-[#f7faf8] p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-[#66736b]">Confirmation code</span>
          <code className="font-mono text-sm font-semibold tracking-[0.14em] text-[#17211b]">{userCode}</code>
        </div>
        <p className="mt-3 text-xs leading-5 text-[#66736b]">
          Expires {new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Approving grants
          this device only the permissions you already have for {gate.selectedCount > 1 ? 'each selected project' : 'the selected project'}.
        </p>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-[#ffc1c7] bg-[#fff1f2] px-3 py-2 text-xs text-[#a40e26]" role="alert">{error}</p>
      ) : null}

      <Button
        size="lg"
        className="mt-6 h-11 w-full rounded-lg bg-[#1a7f37] text-white shadow-[0_8px_20px_rgba(26,127,55,0.2)] hover:bg-[#116329]"
        disabled={!gate.canApprove}
        onClick={approve}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
        {busy
          ? 'Connecting device…'
          : gate.selectedCount > 1 ? `Approve ${gate.selectedCount} projects` : 'Approve this device'}
        {!busy ? <ArrowRight className="ml-auto" /> : null}
      </Button>
    </div>
  )
}

function Detail({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#dce5df] bg-[#fbfcfb] p-4">
      <div className="flex items-center gap-2 text-[#1a7f37]">{icon}<span className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em]">{label}</span></div>
      <p className="mt-2 truncate text-sm font-semibold" title={value}>{value}</p>
    </div>
  )
}
