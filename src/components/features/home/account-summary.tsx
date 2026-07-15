'use client'

import * as React from 'react'
import Link from 'next/link'
import { FolderGit2, HardDrive, Layers3 } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/client/api'
import { cn } from '@/lib/utils'

type Meter = {
  used?: number
  limit?: number
  ratio?: number
  state?: 'ok' | 'warn' | 'block'
}

type BillingStatus = {
  ok?: boolean
  subscription?: { planKey?: string; entitlementActive?: boolean } | null
  usage?: {
    plan?: string
    storage?: Meter
    codebases?: Meter
  } | null
}

export function AccountSummary({ repositoryCount }: { repositoryCount: number }) {
  const [status, setStatus] = React.useState<BillingStatus | null>(null)

  React.useEffect(() => {
    let active = true
    apiFetch<BillingStatus>('/api/billing/status', { allowErrorEnvelope: true })
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch(() => {
        if (active) setStatus({ ok: false })
      })
    return () => {
      active = false
    }
  }, [])

  if (status === null) {
    return (
      <div className="grid gap-3 sm:grid-cols-3" aria-label="Loading account summary">
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-28" />)}
      </div>
    )
  }

  const storage = status.usage?.storage
  const projects = status.usage?.codebases
  const plan = planName(status)

  return (
    <section aria-label="Account summary" className="grid gap-3 sm:grid-cols-3">
      <SummaryCard icon={Layers3} label="Plan" value={plan} detail="View or change your plan" href="/pricing" />
      <SummaryCard
        icon={HardDrive}
        label="Storage"
        value={storage ? `${formatBytes(storage.used)} of ${formatBytes(storage.limit)}` : 'View limits'}
        detail={storage ? meterDetail(storage, 'storage') : 'Storage allowances by plan'}
        meter={storage}
        href="/pricing"
      />
      <SummaryCard
        icon={FolderGit2}
        label="Repositories"
        value={projects?.limit ? `${projects.used ?? repositoryCount} of ${formatCountLimit(projects.limit)}` : String(repositoryCount)}
        detail={meterDetail(projects, 'repositories')}
        meter={projects}
        href="/codebases"
      />
    </section>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  meter,
  href,
}: {
  icon: typeof Layers3
  label: string
  value: string
  detail: string
  meter?: Meter
  href: string
}) {
  const ratio = Math.max(0, Math.min(1, meter?.ratio ?? 0))

  return (
    <Link
      href={href}
      className="group rounded-md border border-border bg-card p-4 outline-none transition-colors hover:border-iris/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</p>
        </div>
        <Icon className="size-4 text-muted-foreground transition-colors group-hover:text-iris" aria-hidden />
      </div>
      {meter?.limit ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn(
              'h-full rounded-full',
              meter.state === 'block' ? 'bg-destructive' : meter.state === 'warn' ? 'bg-amber' : 'bg-hop',
            )}
            style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }}
          />
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </Link>
  )
}

function planName(status: BillingStatus) {
  if (!status.ok) return 'View plans'
  if (status.subscription?.entitlementActive) {
    return status.subscription.planKey === 'plus_storage' ? 'Plus Storage' : 'Plus'
  }
  return status.usage?.plan === 'paid_storage'
    ? 'Plus Storage'
    : status.usage?.plan === 'paid'
      ? 'Plus'
      : 'Free'
}

function meterDetail(meter: Meter | undefined, noun: string) {
  if (!meter) return `Account ${noun} usage`
  if (meter.state === 'block') return `${capitalize(noun)} limit reached`
  if (meter.state === 'warn') return `${capitalize(noun)} limit is getting close`
  return noun === 'storage' ? 'Across your HopIt account' : 'Included with your current plan'
}

function formatBytes(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return '0 GB'
  if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)} MB`
  const gigabytes = value / 1_000_000_000
  return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1).replace(/\.0$/, '')} GB`
}

function formatCountLimit(value: number) {
  return value >= 1_000_000 ? 'unlimited' : value.toLocaleString()
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
