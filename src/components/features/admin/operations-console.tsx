'use client'

import * as React from 'react'
import {
  AlertTriangle,
  Ban,
  CircleDollarSign,
  Database,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Webhook,
} from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/ui/status-dot'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

type Json = Record<string, any>

type PendingAction = {
  action: 'pause_tenant_writes' | 'resume_tenant_writes' | 'revoke_session'
  targetId: string
  label: string
}

const POLL_MS = 30_000

export function OperationsConsole() {
  const { toast } = useToast()
  const [data, setData] = React.useState<Json | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [running, setRunning] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [pending, setPending] = React.useState<PendingAction | null>(null)
  const [reason, setReason] = React.useState('')

  const refresh = React.useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const response = await fetch('/api/admin/operations', { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok === false) throw new Error(body?.error?.message ?? 'Operations data is unavailable.')
      setData(body)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operations data is unavailable.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function runAction(body: Json, label: string) {
    setRunning(String(body.action))
    try {
      const response = await fetch('/api/admin/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const next = await response.json().catch(() => null)
      if (!response.ok || next?.ok === false) throw new Error(next?.error?.message ?? `${label} failed.`)
      setData(next)
      setError(null)
      setPending(null)
      setReason('')
      toast({ title: label, description: 'The service state and audit trail are up to date.' })
    } catch (cause) {
      toast({
        title: `${label} failed`,
        description: cause instanceof Error ? cause.message : 'The operation could not be completed.',
        variant: 'destructive',
      })
    } finally {
      setRunning(null)
    }
  }

  const tenants = Array.isArray(data?.tenants) ? data.tenants : []
  const filteredTenants = tenants.filter((tenant: Json) => {
    const needle = query.trim().toLowerCase()
    return !needle || [tenant.email, tenant.displayName, tenant.tenantId, tenant.plan]
      .some((value) => String(value ?? '').toLowerCase().includes(needle))
  })
  const alerts = data ? buildAlerts(data) : []

  return (
    <PageScaffold
      title="Service operations"
      description="One place to watch tenant pressure, sync health, billing, and the guardrails protecting HopIt."
      actions={
        <>
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <StatusDot tone={error ? 'danger' : 'hop'} pulse={!error} />
            {error ? 'Needs attention' : 'Live · 30s'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => void runAction({ action: 'reconcile_billing' }, 'Billing reconciled')}
            disabled={Boolean(running) || data?.runtime?.billingEnabled !== true}
          >
            <CircleDollarSign />
            Reconcile billing
          </Button>
        </>
      }
    >
      {loading ? <OperationsSkeleton /> : error && !data ? <FatalError message={error} retry={() => void refresh()} /> : data ? (
        <>
          {error ? <InlineNotice tone="danger" title="Live refresh failed" detail={error} /> : null}
          <ServiceRail data={data} />
          <EconomicsPanel economics={data.economics} />
          <AttentionQueue alerts={alerts} />
          <TenantTable
            tenants={filteredTenants}
            query={query}
            onQueryChange={setQuery}
            onAction={(action) => {
              setPending(action)
              setReason('')
            }}
          />
          <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_.85fr]">
            <SessionPanel sessions={data.sessions ?? []} onRevoke={(action) => setPending(action)} />
            <EventPanel events={data.recentEvents ?? []} adminEvents={data.adminEvents ?? []} />
          </div>
        </>
      ) : null}

      <Dialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={pending?.label ?? 'Confirm operation'}
        description={pending?.action === 'pause_tenant_writes'
          ? 'Cloud writes will pause. Reads, exports, deletes that free storage, and local journals remain available.'
          : pending?.action === 'revoke_session'
            ? 'This device must authenticate again before it can sync.'
            : 'Cloud writes will resume under the tenant’s normal plan limits.'}
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant={pending?.action === 'resume_tenant_writes' ? 'default' : 'destructive'}
              disabled={!pending || Boolean(running)}
              onClick={() => {
                if (!pending) return
                void runAction({
                  action: pending.action,
                  ...(pending.action === 'revoke_session'
                    ? { sessionId: pending.targetId }
                    : { tenantId: pending.targetId, reason }),
                  confirmation: pending.targetId,
                }, pending.label)
              }}
            >
              {pending?.action === 'resume_tenant_writes' ? <Play /> : <Ban />}
              Confirm
            </Button>
          </>
        }
      >
        {pending?.action === 'pause_tenant_writes' ? (
          <label className="space-y-2 text-sm font-medium">
            Operator note
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Security review, abuse investigation…" maxLength={240} />
          </label>
        ) : (
          <p className="rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-muted-foreground break-all">
            {pending?.targetId}
          </p>
        )}
      </Dialog>
    </PageScaffold>
  )
}

function ServiceRail({ data }: { data: Json }) {
  const totals = data.totals ?? {}
  const items = [
    { icon: Database, label: 'Data plane', value: data.health?.database === 'operational' ? 'Operational' : 'Unknown', detail: `${totals.tenants ?? 0} tenants`, tone: 'hop' as const },
    { icon: ShieldCheck, label: 'Quota guard', value: data.health?.quotaEnforced ? 'Enforcing' : 'Monitor only', detail: `${totals.writesAt80 ?? 0} near write cap`, tone: data.health?.quotaEnforced ? 'hop' as const : 'amber' as const },
    { icon: Webhook, label: 'Billing', value: data.runtime?.billingConfigured ? 'Connected' : 'Incomplete', detail: data.health?.lastWebhookAt ? `Webhook ${relative(data.health.lastWebhookAt)}` : 'No live event yet', tone: data.runtime?.billingConfigured ? 'hop' as const : 'amber' as const },
    { icon: Smartphone, label: 'Sync fleet', value: `${totals.activeSessions ?? 0} active`, detail: `${totals.codebases ?? 0} repositories`, tone: 'iris' as const },
  ]
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3 px-4 py-3.5">
            <span className={cn('grid size-9 shrink-0 place-items-center rounded-md', item.tone === 'hop' ? 'bg-hop-soft text-hop-soft-foreground' : item.tone === 'amber' ? 'bg-amber-soft text-amber-soft-foreground' : 'bg-iris-soft text-iris-soft-foreground')}>
              <item.icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="font-semibold">{item.value}</p>
              <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EconomicsPanel({ economics }: { economics: Json }) {
  const margin = typeof economics?.marginRatio === 'number' ? economics.marginRatio : null
  const safe = margin === null || margin >= economics.targetFloorRatio
  return (
    <Card className="overflow-hidden">
      <div className="grid lg:grid-cols-[1.15fr_.85fr]">
        <CardContent className="border-b border-border lg:border-b-0 lg:border-r">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Margin watch</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">
                {margin === null ? 'Pre-revenue' : `${percent(margin)} modeled margin`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Today’s writes projected across 30 days · editable cost assumptions</p>
            </div>
            <Badge tone={safe ? 'hop' : 'danger'}>{margin === null ? 'Plan guardrails pass' : safe ? 'Above 50% floor' : 'Below 50% floor'}</Badge>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Metric label="Gross MRR" value={usd(economics.grossMrrUsd)} />
            <Metric label="Modeled cost" value={usd(economics.modeledCostUsd)} />
            <Metric label="Storage" value={`${number(economics.storageGb).toFixed(2)} GB`} />
            <Metric label="Write run-rate" value={compact(economics.monthlyWriteRunRate)} />
          </div>
        </CardContent>
        <CardContent>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">At-plan-maximum guardrails</p>
          <div className="space-y-4">
            {(economics.planGuardrails ?? []).map((plan: Json) => (
              <div key={plan.planKey}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium">{plan.planKey === 'plus_storage' ? 'Plus Storage' : 'Plus'}</span>
                  <span className="font-mono text-xs text-muted-foreground">{percent(plan.marginRatio)} at cap</span>
                </div>
                <Meter ratio={plan.marginRatio} tone={plan.marginRatio >= 0.5 ? 'hop' : 'danger'} />
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Includes modeled payment fees, R2 storage, capped D1 writes, and operations headroom. Shared $5 platform base is shown in live cost.</p>
        </CardContent>
      </div>
    </Card>
  )
}

function AttentionQueue({ alerts }: { alerts: Json[] }) {
  if (alerts.length === 0) {
    return <InlineNotice tone="hop" title="No active guardrail alerts" detail="No tenant is above 80%, blocked, paused, or showing an entitlement mismatch." />
  }
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Attention queue</CardTitle>
        <Badge tone="amber">{alerts.length}</Badge>
      </CardHeader>
      <CardContent className="grid gap-2 pt-3 md:grid-cols-2">
        {alerts.slice(0, 8).map((alert) => (
          <div key={alert.id} className="flex gap-3 rounded-md border border-border bg-muted/30 p-3">
            <AlertTriangle className={cn('mt-0.5 size-4 shrink-0', alert.tone === 'danger' ? 'text-danger' : 'text-amber')} />
            <div className="min-w-0">
              <p className="text-sm font-medium">{alert.title}</p>
              <p className="truncate text-xs text-muted-foreground">{alert.detail}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function TenantTable({ tenants, query, onQueryChange, onAction }: { tenants: Json[]; query: string; onQueryChange: (value: string) => void; onAction: (action: PendingAction) => void }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <h2 className="font-semibold">Tenants</h2>
          <p className="text-xs text-muted-foreground">Plan, quota pressure, devices, and emergency write controls.</p>
        </div>
        <Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Find tenant…" className="h-8 w-full sm:w-64" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-2.5 font-medium">Tenant</th>
              <th className="px-4 py-2.5 font-medium">Plan</th>
              <th className="w-48 px-4 py-2.5 font-medium">Storage</th>
              <th className="w-48 px-4 py-2.5 font-medium">Writes today</th>
              <th className="px-4 py-2.5 font-medium">Fleet</th>
              <th className="px-5 py-2.5 text-right font-medium">Control</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tenants.map((tenant) => (
              <tr key={tenant.tenantId} className="align-middle hover:bg-muted/20">
                <td className="px-5 py-3">
                  <p className="max-w-56 truncate font-medium">{tenant.displayName || tenant.email || 'Unnamed tenant'}</p>
                  <p className="max-w-56 truncate font-mono text-[11px] text-muted-foreground">{tenant.email || tenant.tenantId}</p>
                </td>
                <td className="px-4 py-3"><PlanBadge tenant={tenant} /></td>
                <td className="px-4 py-3"><QuotaCell meter={tenant.quota?.storage} format={bytes} /></td>
                <td className="px-4 py-3"><QuotaCell meter={tenant.quota?.dailyWrites} format={compact} /></td>
                <td className="px-4 py-3">
                  <p className="font-medium">{tenant.activeSessionCount} active</p>
                  <p className="text-xs text-muted-foreground">{tenant.codebaseCount} repos · {tenant.lastSeenAt ? relative(tenant.lastSeenAt) : 'never seen'}</p>
                </td>
                <td className="px-5 py-3 text-right">
                  <Button
                    variant={tenant.writesPaused ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => onAction({
                      action: tenant.writesPaused ? 'resume_tenant_writes' : 'pause_tenant_writes',
                      targetId: tenant.tenantId,
                      label: tenant.writesPaused ? 'Tenant writes resumed' : 'Tenant writes paused',
                    })}
                  >
                    {tenant.writesPaused ? <Play /> : <Ban />}
                    {tenant.writesPaused ? 'Resume' : 'Pause writes'}
                  </Button>
                </td>
              </tr>
            ))}
            {tenants.length === 0 ? <tr><td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">No tenants match this search.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function SessionPanel({ sessions, onRevoke }: { sessions: Json[]; onRevoke: (action: PendingAction) => void }) {
  const active = sessions.filter((session) => session.status === 'active')
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div><CardTitle>Active devices</CardTitle><p className="mt-1 text-xs text-muted-foreground">Most recently seen sync sessions.</p></div>
        <Badge tone="outline">{active.length}</Badge>
      </CardHeader>
      <CardContent className="space-y-1 pt-3">
        {active.slice(0, 10).map((session) => (
          <div key={session.sessionId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Smartphone className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{session.deviceName || 'Unnamed device'} <span className="font-normal text-muted-foreground">· {session.codebaseName}</span></p>
              <p className="truncate text-xs text-muted-foreground">{session.tenantId} · seen {relative(session.lastSeenAt)}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onRevoke({ action: 'revoke_session', targetId: session.sessionId, label: 'Device session revoked' })}>Revoke</Button>
          </div>
        ))}
        {active.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No active device sessions.</p> : null}
      </CardContent>
    </Card>
  )
}

function EventPanel({ events, adminEvents }: { events: Json[]; adminEvents: Json[] }) {
  const combined = [
    ...events.map((event) => ({ id: `event-${event.id}`, title: event.event, detail: event.codebaseName || event.codebaseId, at: event.at, type: 'sync' })),
    ...adminEvents.map((event) => ({ id: event.event_id, title: event.action.replaceAll('_', ' '), detail: `${event.target_type} · ${event.target_id}`, at: event.created_at, type: 'admin' })),
  ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 14)
  return (
    <Card>
      <CardHeader><CardTitle>Service trail</CardTitle><p className="text-xs text-muted-foreground">Recent sync and owner-control events.</p></CardHeader>
      <CardContent className="pt-3">
        <div className="space-y-0.5">
          {combined.map((event) => (
            <div key={event.id} className="flex gap-3 border-l border-border py-2 pl-4">
              <span className={cn('-ml-[1.19rem] mt-1.5 size-2 rounded-full ring-4 ring-card', event.type === 'admin' ? 'bg-amber' : 'bg-iris')} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium capitalize">{event.title}</p>
                <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">{relative(event.at)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function QuotaCell({ meter, format }: { meter: Json; format: (value: number) => string }) {
  const ratio = number(meter?.ratio)
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'amber' : 'hop'
  return <div><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium">{format(number(meter?.used))}</span><span className="text-muted-foreground">{percent(ratio)}</span></div><Meter ratio={ratio} tone={tone} /></div>
}

function Meter({ ratio, tone }: { ratio: number; tone: 'hop' | 'amber' | 'danger' }) {
  return <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full transition-[width]', tone === 'hop' ? 'bg-hop' : tone === 'amber' ? 'bg-amber' : 'bg-danger')} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></div>
}

function PlanBadge({ tenant }: { tenant: Json }) {
  if (tenant.writesPaused) return <Badge tone="danger">Writes paused</Badge>
  const tone: BadgeTone = tenant.plan === 'free' ? 'outline' : 'iris'
  return <Badge tone={tone}>{tenant.plan === 'paid_storage' ? 'Plus Storage' : tenant.plan === 'paid' ? 'Plus' : 'Free'}</Badge>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 text-lg font-semibold tracking-tight">{value}</p></div>
}

function InlineNotice({ tone, title, detail }: { tone: 'hop' | 'danger'; title: string; detail: string }) {
  return <div className={cn('flex items-start gap-3 rounded-md border p-3', tone === 'hop' ? 'border-hop/25 bg-hop-soft/50' : 'border-danger/25 bg-danger-soft/50')}><ShieldCheck className={cn('mt-0.5 size-4', tone === 'hop' ? 'text-hop' : 'text-danger')} /><div><p className="font-medium">{title}</p><p className="text-xs text-muted-foreground">{detail}</p></div></div>
}

function FatalError({ message, retry }: { message: string; retry: () => void }) {
  return <Card><CardContent className="flex flex-col items-center py-12 text-center"><AlertTriangle className="mb-3 size-8 text-danger" /><h2 className="font-semibold">Operations console unavailable</h2><p className="mt-1 max-w-lg text-sm text-muted-foreground">{message}</p><Button className="mt-4" onClick={retry}>Try again</Button></CardContent></Card>
}

function OperationsSkeleton() {
  return <><Skeleton className="h-24" /><Skeleton className="h-56" /><Skeleton className="h-72" /></>
}

function buildAlerts(data: Json) {
  const alerts: Json[] = []
  for (const tenant of data.tenants ?? []) {
    const label = tenant.email || tenant.tenantId
    for (const [key, title] of [['storage', 'Storage pressure'], ['dailyWrites', 'Daily write pressure']]) {
      const meter = tenant.quota?.[key]
      if (meter?.ratio >= 0.8) alerts.push({ id: `${tenant.tenantId}-${key}`, tone: meter.ratio >= 1 ? 'danger' : 'amber', title, detail: `${label} is at ${percent(meter.ratio)}.` })
    }
    if (tenant.writesPaused) alerts.push({ id: `${tenant.tenantId}-paused`, tone: 'danger', title: 'Tenant writes paused', detail: `${label}${tenant.pauseReason ? ` · ${tenant.pauseReason}` : ''}` })
    const entitlement = tenant.subscription?.entitlementActive === true
    if ((entitlement && tenant.plan === 'free') || (!entitlement && tenant.plan !== 'free')) alerts.push({ id: `${tenant.tenantId}-billing`, tone: 'danger', title: 'Billing entitlement mismatch', detail: label })
  }
  const failed = number(data.totals?.actionJobs24h?.failed)
  if (failed > 0) alerts.push({ id: 'failed-actions', tone: 'amber', title: 'Failed action jobs', detail: `${failed} failed during the last 24 hours.` })
  return alerts
}

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function percent(value: unknown) { return `${Math.round(number(value) * 100)}%` }
function compact(value: unknown) { return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(number(value)) }
function usd(value: unknown) { return Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number(value)) }
function bytes(value: number) { if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`; if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`; return `${(value / 1_000_000_000).toFixed(2)} GB` }
function relative(value: unknown) { const at = Date.parse(String(value ?? '')); if (!Number.isFinite(at)) return 'unknown'; const delta = Date.now() - at; if (delta < 60_000) return 'just now'; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return `${Math.floor(delta / 86_400_000)}d ago` }
