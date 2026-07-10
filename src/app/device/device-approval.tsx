'use client'

import * as React from 'react'
import { ArrowRight, CheckCircle2, Clock3, Laptop, LoaderCircle, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'

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
}: {
  userCode: string
  initialStatus: string
  device: DeviceInfo
  expiresAt: string
  codebases: Array<{ id: string; name: string }>
}) {
  const [codebaseId, setCodebaseId] = React.useState(codebases[0]?.id ?? '')
  const [status, setStatus] = React.useState(initialStatus)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

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

      <label className="block">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#637067]">Project access</span>
        <select
          value={codebaseId}
          onChange={(event) => setCodebaseId(event.target.value)}
          className="mt-2 h-11 w-full rounded-lg border border-[#bac8bf] bg-white px-3 text-sm font-medium shadow-sm outline-none transition focus:border-[#1a7f37] focus:ring-4 focus:ring-[#1a7f37]/10"
        >
          {codebases.length === 0 ? <option value="">No projects available</option> : null}
          {codebases.map((codebase) => (
            <option key={codebase.id} value={codebase.id}>{codebase.name}</option>
          ))}
        </select>
      </label>

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
        disabled={!codebaseId || busy}
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
