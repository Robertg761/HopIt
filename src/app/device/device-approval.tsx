'use client'

import * as React from 'react'
import { ArrowRight, CheckCircle2, Clock3, Laptop, LoaderCircle, Plus, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { deviceApprovalGate, normalizeDeviceCodebaseOptions, type DeviceCodebaseOption } from './codebase-options'

type DeviceInfo = {
  id?: string | null
  name?: string | null
  platform?: string | null
}

export function DeviceApproval({
  userCode,
  initialStatus,
  device,
  expiresAt,
  codebases,
  requestedCodebaseId = null,
  requestedCodebaseName = null,
}: {
  userCode: string
  initialStatus: string
  device: DeviceInfo
  expiresAt: string
  codebases: Array<{ id: string; name: string }>
  requestedCodebaseId?: string | null
  requestedCodebaseName?: string | null
}) {
  const requestedId = requestedCodebaseId?.trim() || null
  const requestedName = requestedCodebaseName?.trim() || requestedId || null
  const [availableCodebases, setAvailableCodebases] = React.useState<DeviceCodebaseOption[]>(codebases)
  const requestedExists = requestedId ? availableCodebases.some((option) => option.id === requestedId) : false
  // When the terminal asked to create a project that does not exist yet, we must
  // NOT pre-select an existing project — otherwise a single click on "Approve"
  // would connect the device to the wrong project (the live incident).
  const [codebaseId, setCodebaseId] = React.useState(
    requestedId ? (requestedExists ? requestedId : '') : codebases[0]?.id ?? '',
  )
  const [newCodebaseName, setNewCodebaseName] = React.useState(requestedName ?? '')
  const [status, setStatus] = React.useState(initialStatus)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [creatingCodebase, setCreatingCodebase] = React.useState(false)
  // Secondary, deliberately-gated path for approving a DIFFERENT existing project
  // than the one the terminal requested.
  const [showExistingOverride, setShowExistingOverride] = React.useState(false)
  const [overrideAcknowledged, setOverrideAcknowledged] = React.useState(false)

  const { requestedNeedsCreate, canApprove } = deviceApprovalGate({
    requestedId,
    requestedExists,
    selectedCodebaseId: codebaseId,
    overrideAcknowledged,
    busy,
  })

  function collapseExistingOverride() {
    setShowExistingOverride(false)
    setOverrideAcknowledged(false)
    setCodebaseId('')
  }

  // Create a project, optionally with the id the terminal requested, then select it.
  async function createCodebase(name: string, desiredId?: string | null) {
    const trimmedName = name.trim()
    if (!trimmedName || creatingCodebase) return
    setCreatingCodebase(true)
    setError(null)
    try {
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
      const createdId = normalizeDeviceCodebaseOptions([body.codebase])[0]?.id
      setAvailableCodebases(options)
      setCodebaseId(createdId && options.some((option) => option.id === createdId) ? createdId : options[0].id)
      if (!desiredId) setNewCodebaseName('')
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : 'Project creation failed.')
    } finally {
      setCreatingCodebase(false)
    }
  }

  function createFirstCodebase() {
    return createCodebase(newCodebaseName)
  }

  async function approve() {
    if (!codebaseId || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/device-authorizations/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode, codebaseId }),
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
        <h2 className="text-xl font-semibold tracking-[-0.02em]">Device connected</h2>
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
            <p className="text-sm font-semibold">Authorization {status}</p>
            <p className="mt-1 text-xs leading-5">Return to your terminal and run hop setup again.</p>
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

      {requestedNeedsCreate ? (
        <>
          <div className="mb-5 rounded-xl border border-[#b7dfc1] bg-[#f0fff4] p-4">
            <p className="text-sm font-semibold text-[#116329]">Create the requested project</p>
            <p className="mt-1 text-xs leading-5 text-[#3d6b4c]">
              Your terminal asked to connect a new project. This is the action you almost certainly want.
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[#b7dfc1] bg-white px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[#17211b]" title={requestedName ?? requestedId ?? ''}>{requestedName}</span>
                <span className="block font-mono text-[11px] text-[#5d6a62]">{requestedId}</span>
              </span>
              <Button
                type="button"
                className="shrink-0 bg-[#1a7f37] text-white hover:bg-[#116329]"
                disabled={creatingCodebase}
                onClick={() => void createCodebase(requestedName ?? requestedId ?? '', requestedId)}
              >
                {creatingCodebase ? <LoaderCircle className="animate-spin" /> : <Plus />}
                {creatingCodebase ? 'Creating…' : `Create ${requestedId}`}
              </Button>
            </div>
          </div>

          {availableCodebases.length > 0 ? (
            <div className="mb-5 rounded-xl border border-[#e4b9bd] bg-[#fff5f5] p-4">
              {!showExistingOverride ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-[#a40e26] underline underline-offset-2"
                  onClick={() => setShowExistingOverride(true)}
                >
                  Choose an existing project instead…
                </button>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-[#a40e26]">Connect to an existing project instead</p>
                  <p className="mt-1 text-xs leading-5 text-[#7d2b34]">
                    Your terminal asked for <span className="font-mono font-semibold">{requestedId}</span>. Pointing it at
                    a different existing project makes this device operate on that project — its managed workspace can be
                    overwritten by the import. Only do this if you are certain.
                  </p>
                  <label className="mt-3 block">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7d2b34]">Existing project</span>
                    <select
                      value={codebaseId}
                      onChange={(event) => setCodebaseId(event.target.value)}
                      className="mt-2 h-11 w-full rounded-lg border border-[#e4b9bd] bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-[#a40e26] focus:ring-4 focus:ring-[#a40e26]/10"
                    >
                      <option value="">Select a project…</option>
                      {availableCodebases.map((codebase) => (
                        <option key={codebase.id} value={codebase.id}>{codebase.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-[#7d2b34]">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-[#a40e26]"
                      checked={overrideAcknowledged}
                      onChange={(event) => setOverrideAcknowledged(event.target.checked)}
                    />
                    <span>
                      I understand this device asked for <span className="font-mono font-semibold">{requestedId}</span> and
                      connecting it to the selected existing project will make it operate on that project.
                    </span>
                  </label>
                  <button
                    type="button"
                    className="mt-3 text-xs font-medium text-[#66736b] underline underline-offset-2"
                    onClick={collapseExistingOverride}
                  >
                    Cancel — create {requestedId} instead
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </>
      ) : availableCodebases.length > 0 ? (
        <label className="block">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#637067]">Project access</span>
          <select
            value={codebaseId}
            onChange={(event) => setCodebaseId(event.target.value)}
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
              disabled={!newCodebaseName.trim() || creatingCodebase}
              onClick={() => void createFirstCodebase()}
            >
              {creatingCodebase ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {creatingCodebase ? 'Creating…' : 'Create project'}
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
          Expires {new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Approving grants this device only the permissions you already have for the selected project.
        </p>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-[#ffc1c7] bg-[#fff1f2] px-3 py-2 text-xs text-[#a40e26]" role="alert">{error}</p>
      ) : null}

      <Button
        size="lg"
        className="mt-6 h-11 w-full rounded-lg bg-[#1a7f37] text-white shadow-[0_8px_20px_rgba(26,127,55,0.2)] hover:bg-[#116329]"
        disabled={!canApprove}
        onClick={approve}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
        {busy ? 'Connecting device…' : 'Approve this device'}
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
