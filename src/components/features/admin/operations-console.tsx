'use client'

import * as React from 'react'
import {
  Activity,
  AlertTriangle,
  Ban,
  CircleDollarSign,
  Database,
  Download,
  ExternalLink,
  GitBranch,
  HardDrive,
  KeyRound,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  UserPlus,
  Users,
  Webhook,
  XCircle,
} from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/ui/status-dot'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

type Json = Record<string, any>

type PendingAction = {
  action:
    | 'pause_tenant_writes'
    | 'resume_tenant_writes'
    | 'revoke_session'
    | 'revoke_tenant_sessions'
    | 'revoke_device'
    | 'expire_device_authorization'
    | 'cancel_action_job'
    | 'requeue_action_job'
    | 'reconcile_billing'
    | 'set_subscription_cancellation'
  targetId: string
  targetType: 'tenant' | 'session' | 'device' | 'authorization' | 'job' | 'service'
  label: string
  detail?: string
  cancelAtPeriodEnd?: boolean
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
  const [selectedTenantId, setSelectedTenantId] = React.useState<string | null>(null)
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
      const warnings = [
        ...(Array.isArray(next?.operation?.warnings) ? next.operation.warnings : []),
        ...(typeof next?.refreshWarning === 'string' ? [next.refreshWarning] : []),
      ]
      if (next?.snapshotAvailable === false) {
        void refresh(true)
      } else {
        setData(next)
      }
      setError(null)
      setPending(null)
      setReason('')
      toast({
        title: warnings.length ? `${label} with warnings` : label,
        description: warnings[0] ?? 'The service state and audit trail are up to date.',
      })
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
  const selectedTenant = tenants.find((tenant: Json) => tenant.tenantId === selectedTenantId) ?? null

  function exportSnapshot() {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `hopit-operations-${new Date().toISOString().replaceAll(':', '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

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
          <Button variant="outline" size="sm" onClick={exportSnapshot} disabled={!data}>
            <Download />
            Export
          </Button>
          <Button
            size="sm"
            onClick={() => setPending({
              action: 'reconcile_billing',
              targetId: 'hopit-service',
              targetType: 'service',
              label: 'Billing reconciled',
              detail: 'Stripe will be compared with every stored entitlement. Tenant plans may change to match the provider state.',
            })}
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
          <CollectionScopeNotice collections={data.collections ?? {}} />
          <Tabs defaultValue="overview">
            <TabsList className="sticky top-0 z-10 bg-background/95 backdrop-blur">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tenants" count={tenants.length}>Tenants</TabsTrigger>
              <TabsTrigger value="billing" count={number(data.totals?.activeSubscriptions)}>Billing</TabsTrigger>
              <TabsTrigger value="fleet" count={number(data.totals?.activeSessions)}>Fleet & sync</TabsTrigger>
              <TabsTrigger value="infrastructure">Infrastructure</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <GrowthPanel data={data} />
              <EconomicsPanel economics={data.economics} />
              <AttentionQueue alerts={alerts} />
              <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_.85fr]">
                <JobsPanel jobs={data.actionJobs ?? []} onAction={setPending} compact />
                <EventPanel events={data.recentEvents ?? []} adminEvents={data.adminEvents ?? []} />
              </div>
            </TabsContent>

            <TabsContent value="tenants" className="space-y-4">
              <TenantTable
                tenants={filteredTenants}
                query={query}
                onQueryChange={setQuery}
                onOpen={(tenantId) => setSelectedTenantId(tenantId)}
                onAction={(action) => {
                  setPending(action)
                  setReason('')
                }}
              />
            </TabsContent>

            <TabsContent value="billing" className="space-y-4">
              <BillingPanel data={data} onAction={setPending} />
              <EconomicsPanel economics={data.economics} />
            </TabsContent>

            <TabsContent value="fleet" className="space-y-4">
              <FleetPanel data={data} onAction={setPending} />
              <JobsPanel jobs={data.actionJobs ?? []} onAction={setPending} />
            </TabsContent>

            <TabsContent value="infrastructure" className="space-y-4">
              <ConfigurationPanel data={data} />
              <RepositoryInventory codebases={data.codebases ?? []} />
              <SecurityPanel security={data.security ?? {}} />
            </TabsContent>

            <TabsContent value="audit" className="space-y-4">
              <AuditLedger data={data} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}

      <TenantDetailDialog
        tenant={selectedTenant}
        data={data}
        onClose={() => setSelectedTenantId(null)}
        onAction={(action) => {
          setPending(action)
          setReason('')
        }}
      />

      <Dialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={pending?.label ?? 'Confirm operation'}
        description={pending?.detail ?? actionDescription(pending)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant={safeAction(pending) ? 'default' : 'destructive'}
              disabled={!pending || Boolean(running)}
              onClick={() => {
                if (!pending) return
                void runAction(actionBody(pending, reason), pending.label)
              }}
            >
              {safeAction(pending) ? <Play /> : <Ban />}
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
        ) : <ConfirmationTarget target={pending?.targetId} />}
      </Dialog>
    </PageScaffold>
  )
}

function ServiceRail({ data }: { data: Json }) {
  const totals = data.totals ?? {}
  const billingConfigured = data.runtime?.billingConfigured === true
  const lastWebhookAt = Date.parse(String(data.health?.lastWebhookAt ?? ''))
  const billingVerified = Number.isFinite(lastWebhookAt) && Date.now() - lastWebhookAt < 45 * 24 * 60 * 60 * 1000
  const billingVerificationStale = Number.isFinite(lastWebhookAt) && !billingVerified
  const items = [
    { icon: Database, label: 'Data plane', value: data.health?.database === 'operational' ? 'Operational' : 'Unknown', detail: `${totals.tenants ?? 0} tenants`, tone: 'hop' as const },
    { icon: ShieldCheck, label: 'Quota guard', value: data.health?.quotaEnforced ? 'Enforcing' : 'Monitor only', detail: `${totals.writesAt80 ?? 0} near write cap`, tone: data.health?.quotaEnforced ? 'hop' as const : 'amber' as const },
    { icon: Webhook, label: 'Billing', value: !billingConfigured ? 'Incomplete' : billingVerified ? 'Verified' : billingVerificationStale ? 'Verification stale' : 'Configured', detail: Number.isFinite(lastWebhookAt) ? `Last signed webhook ${relative(data.health.lastWebhookAt)}` : 'Awaiting a signed live event', tone: billingVerified ? 'hop' as const : 'amber' as const },
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

function CollectionScopeNotice({ collections }: { collections: Json }) {
  const partial = Object.entries(collections)
    .map(([name, value]) => ({ name, value: value as Json }))
    .filter(({ value }) => value?.truncated === true)
  if (!partial.length) return null
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber/25 bg-amber-soft/50 p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" />
      <div>
        <p className="font-medium">Recent-detail window</p>
        <p className="text-xs text-muted-foreground">
          Global totals and quota alerts cover every record. Detail lists are bounded: {partial.map(({ name, value }) => `${name} ${compact(value.shown)} of ${compact(value.total)}`).join(' · ')}.
        </p>
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

function GrowthPanel({ data }: { data: Json }) {
  const totals = data.totals ?? {}
  const syncEvents = Object.entries(totals.eventTypes24h ?? {}).reduce((sum, [, value]) => sum + number(value), 0)
  const metrics = [
    { icon: Users, label: 'Accounts', value: compact(totals.users), detail: `${compact(totals.newUsers7d)} new in 7d` },
    { icon: GitBranch, label: 'Repositories', value: compact(totals.codebases), detail: `${compact(data.codebases?.reduce((sum: number, repo: Json) => sum + number(repo.fileCount), 0))} files` },
    { icon: HardDrive, label: 'Tracked storage', value: bytes(number(totals.totalStorageBytes)), detail: `${compact(totals.storageAt80)} near cap` },
    { icon: Activity, label: 'Sync events', value: compact(syncEvents), detail: 'Last 24 hours' },
    { icon: UserPlus, label: 'Pending setup', value: compact(totals.pendingDeviceAuthorizations), detail: `${compact(totals.activeDevices)} trusted devices` },
    { icon: Terminal, label: 'Action failures', value: compact(totals.actionJobs24h?.failed), detail: `${compact(totals.actionJobs24h?.running)} running` },
  ]
  return (
    <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 xl:grid-cols-6">
      {metrics.map((metric) => (
        <div key={metric.label} className="bg-card p-4">
          <metric.icon className="mb-3 size-4 text-muted-foreground" />
          <p className="text-2xl font-semibold tracking-tight">{metric.value}</p>
          <p className="mt-1 text-xs font-medium">{metric.label}</p>
          <p className="text-[11px] text-muted-foreground">{metric.detail}</p>
        </div>
      ))}
    </div>
  )
}

function TenantActions({ tenant, onAction }: { tenant: Json; onAction: (action: PendingAction) => void }) {
  const subscription = tenant.subscription
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="icon-sm" aria-label={`Manage ${tenant.email || tenant.tenantId}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={() => onAction({
          action: tenant.writesPaused ? 'resume_tenant_writes' : 'pause_tenant_writes',
          targetId: tenant.tenantId,
          targetType: 'tenant',
          label: tenant.writesPaused ? 'Tenant writes resumed' : 'Tenant writes paused',
        })}>{tenant.writesPaused ? <Play /> : <Ban />}{tenant.writesPaused ? 'Resume cloud writes' : 'Pause cloud writes'}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={!tenant.activeSessionCount} onSelect={() => onAction({
          action: 'revoke_tenant_sessions', targetId: tenant.tenantId, targetType: 'tenant', label: 'Tenant sessions revoked',
          detail: 'Every active sync session owned by this tenant will be revoked. Each device must authenticate again.',
        })}><XCircle />Revoke all sessions</DropdownMenuItem>
        {subscription?.providerSubscriptionId ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onAction({
            action: 'set_subscription_cancellation', targetId: tenant.tenantId, targetType: 'tenant',
            label: subscription.cancelAtPeriodEnd ? 'Subscription renewal resumed' : 'Subscription set to cancel',
            cancelAtPeriodEnd: !subscription.cancelAtPeriodEnd,
            detail: subscription.cancelAtPeriodEnd
              ? 'Stripe will resume renewal at the next billing period. No immediate charge is created by this action.'
              : 'Stripe will cancel this subscription at the end of its paid period. Access remains active until then.',
          })}><CircleDollarSign />{subscription.cancelAtPeriodEnd ? 'Resume renewal' : 'Cancel at period end'}</DropdownMenuItem>
          <DropdownMenuItem asChild><a href={stripeSubscriptionUrl(subscription.providerSubscriptionId)} target="_blank" rel="noreferrer"><ExternalLink />Open in Stripe</a></DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BillingPanel({ data, onAction }: { data: Json; onAction: (action: PendingAction) => void }) {
  const billed = (data.tenants ?? []).filter((tenant: Json) => tenant.subscription)
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_.65fr]">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between"><div><CardTitle>Subscriptions</CardTitle><p className="mt-1 text-xs text-muted-foreground">Stripe owns entitlement; this console controls renewal and reconciliation.</p></div><Badge tone="iris">{billed.length}</Badge></CardHeader>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-2.5 font-medium">Tenant</th><th className="px-4 py-2.5 font-medium">Plan</th><th className="px-4 py-2.5 font-medium">State</th><th className="px-4 py-2.5 font-medium">Period</th><th className="px-5 py-2.5 text-right font-medium">Manage</th></tr></thead>
            <tbody className="divide-y divide-border">
              {billed.map((tenant: Json) => <tr key={tenant.tenantId}>
                <td className="px-5 py-3"><p className="font-medium">{tenant.displayName || tenant.email}</p><p className="font-mono text-[11px] text-muted-foreground">{tenant.subscription.providerCustomerId}</p></td>
                <td className="px-4 py-3"><PlanBadge tenant={tenant} /></td>
                <td className="px-4 py-3"><Badge tone={tenant.subscription.entitlementActive ? 'hop' : 'danger'}>{tenant.subscription.status}</Badge>{tenant.subscription.cancelAtPeriodEnd ? <p className="mt-1 text-[11px] text-amber">Cancels at period end</p> : null}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{tenant.subscription.currentPeriodEnd ? absoluteDate(tenant.subscription.currentPeriodEnd) : 'Not reported'}</td>
                <td className="px-5 py-3 text-right"><TenantActions tenant={tenant} onAction={onAction} /></td>
              </tr>)}
              {!billed.length ? <tr><td colSpan={5} className="px-5 py-10 text-center text-muted-foreground">No Stripe subscriptions yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader><CardTitle>Webhook ledger</CardTitle><p className="text-xs text-muted-foreground">Accepted, signed Stripe events.</p></CardHeader>
        <CardContent className="space-y-2 pt-3">
          {(data.webhooks ?? []).slice(0, 12).map((event: Json) => <div key={event.event_id} className="rounded-md border border-border p-3"><p className="truncate font-mono text-[11px]">{event.event_id}</p><p className="mt-1 text-xs text-muted-foreground">Received {relative(event.received_at)}</p></div>)}
          {!data.webhooks?.length ? <p className="py-8 text-center text-sm text-muted-foreground">No live webhook recorded yet.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function FleetPanel({ data, onAction }: { data: Json; onAction: (action: PendingAction) => void }) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <SessionPanel sessions={data.sessions ?? []} onRevoke={onAction} />
      <Card><CardHeader><CardTitle>Trusted devices</CardTitle><p className="text-xs text-muted-foreground">Device keys and their trust state.</p></CardHeader><CardContent className="space-y-1 pt-3">
        {(data.devices ?? []).slice(0, 20).map((device: Json) => <div key={device.deviceId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"><KeyRound className="size-4 text-muted-foreground"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{device.displayName || device.deviceId}</p><p className="truncate text-xs text-muted-foreground">{device.platform || 'Unknown platform'} · {device.status} · {device.lastSeenAt ? relative(device.lastSeenAt) : 'never seen'}</p></div>{device.status !== 'revoked' ? <Button variant="ghost" size="sm" onClick={() => onAction({ action: 'revoke_device', targetId: device.deviceId, targetType: 'device', label: 'Device revoked' })}>Revoke</Button> : null}</div>)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Setup authorizations</CardTitle><p className="text-xs text-muted-foreground">Recent pairing attempts without exposing approval codes.</p></CardHeader><CardContent className="space-y-1 pt-3">
        {(data.deviceAuthorizations ?? []).slice(0, 20).map((authorization: Json) => <div key={authorization.authorizationId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"><Smartphone className="size-4 text-muted-foreground"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{authorization.deviceName || authorization.deviceId}</p><p className="truncate text-xs text-muted-foreground">{authorization.status} · {relative(authorization.createdAt)}</p></div>{['pending', 'approving'].includes(authorization.status) ? <Button variant="ghost" size="sm" onClick={() => onAction({ action: 'expire_device_authorization', targetId: authorization.authorizationId, targetType: 'authorization', label: 'Authorization expired' })}>Expire</Button> : null}</div>)}
      </CardContent></Card>
    </div>
  )
}

function JobsPanel({ jobs, onAction, compact: compactView = false }: { jobs: Json[]; onAction: (action: PendingAction) => void; compact?: boolean }) {
  const visible = compactView ? jobs.slice(0, 8) : jobs
  return <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Hosted actions</CardTitle><p className="mt-1 text-xs text-muted-foreground">Queue, runner, exit state, and safe recovery controls.</p></div><Badge tone="outline">{jobs.length}</Badge></CardHeader><CardContent className="space-y-1 pt-3">
    {visible.map((job) => <div key={job.jobId} className="flex items-center gap-3 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-muted/30"><Terminal className="size-4 text-muted-foreground"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{job.kind} <span className="font-normal text-muted-foreground">· {job.codebaseName || job.codebaseId}</span></p><p className="truncate text-xs text-muted-foreground">{job.status} · {job.summary || job.command} · {relative(job.updatedAt)}</p></div>{job.status === 'queued' ? <Button variant="ghost" size="sm" onClick={() => onAction({ action: 'cancel_action_job', targetId: job.jobId, targetType: 'job', label: 'Action job canceled' })}>Cancel</Button> : job.status === 'failed' ? <Button variant="ghost" size="sm" onClick={() => onAction({ action: 'requeue_action_job', targetId: job.jobId, targetType: 'job', label: 'Action job requeued', detail: 'The same hosted action will be queued again and may repeat external side effects.' })}><RotateCcw/>Retry</Button> : null}</div>)}
    {!visible.length ? <p className="py-8 text-center text-sm text-muted-foreground">No hosted action jobs.</p> : null}
  </CardContent></Card>
}

function ConfigurationPanel({ data }: { data: Json }) {
  const runtime = data.runtime ?? {}
  const entries = [
    ['Multi-tenant isolation', runtime.features?.multiTenant], ['Quota enforcement', runtime.features?.quotaEnforcement],
    ['Stripe billing', runtime.features?.billing], ['Clerk authentication', runtime.features?.clerk],
    ['Owner email', runtime.configured?.ownerEmail], ['Server actor token', runtime.configured?.serverActor],
    ['D1 Worker', runtime.configured?.worker], ['Stripe webhook', runtime.configured?.stripeWebhook],
  ]
  return <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Runtime configuration</CardTitle><p className="mt-1 text-xs text-muted-foreground">Presence and feature state only. Secret values never reach the browser.</p></div><Badge tone="outline">{runtime.environment || 'unknown'}</Badge></CardHeader><CardContent className="grid gap-3 pt-3 md:grid-cols-2 xl:grid-cols-4">
    {entries.map(([label, active]) => <div key={String(label)} className="flex items-center justify-between rounded-md border border-border p-3"><span className="text-sm">{String(label)}</span><Badge tone={active ? 'hop' : 'danger'}>{active ? 'On' : 'Off'}</Badge></div>)}
    <div className="md:col-span-2 xl:col-span-4 flex flex-wrap gap-2 border-t border-border pt-3">
      {Object.entries(runtime.links ?? {}).filter(([, href]) => href).map(([label, href]) => <Button key={label} asChild variant="outline" size="sm"><a href={String(href)} target="_blank" rel="noreferrer"><ExternalLink/>{label}</a></Button>)}
      <span className="ml-auto self-center font-mono text-[11px] text-muted-foreground">{runtime.deployment?.commitSha?.slice(0, 8) || 'commit unknown'} · {runtime.deployment?.region || 'region unknown'}</span>
    </div>
  </CardContent></Card>
}

function RepositoryInventory({ codebases }: { codebases: Json[] }) {
  return <Card className="overflow-hidden"><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Repository inventory</CardTitle><p className="mt-1 text-xs text-muted-foreground">All tenant workspaces, revisions, privacy mix, and last movement.</p></div><Badge tone="outline">{codebases.length}</Badge></CardHeader><div className="overflow-x-auto border-t border-border"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-2.5 font-medium">Repository</th><th className="px-4 py-2.5 font-medium">Owner</th><th className="px-4 py-2.5 font-medium">Revision</th><th className="px-4 py-2.5 font-medium">Files</th><th className="px-4 py-2.5 font-medium">Members</th><th className="px-5 py-2.5 font-medium">Updated</th></tr></thead><tbody className="divide-y divide-border">{codebases.map((repo) => <tr key={repo.codebaseId}><td className="px-5 py-3"><p className="font-medium">{repo.name}</p><p className="font-mono text-[11px] text-muted-foreground">{repo.codebaseId}</p></td><td className="px-4 py-3 text-xs">{repo.ownerEmail || repo.tenantId}</td><td className="px-4 py-3 font-mono text-xs">{repo.revision}</td><td className="px-4 py-3">{compact(repo.fileCount)} <span className="text-xs text-muted-foreground">({compact(repo.privateFileCount)} private)</span></td><td className="px-4 py-3">{repo.memberCount}</td><td className="px-5 py-3 text-xs text-muted-foreground">{relative(repo.updatedAt)}</td></tr>)}</tbody></table></div></Card>
}

function SecurityPanel({ security }: { security: Json }) {
  return <div className="grid gap-4 lg:grid-cols-3"><SecurityCard title="User keyrings" icon={KeyRound} rows={(security.userKeyrings ?? []).map((row: Json) => [`${row.status}${row.recoveryConfigured ? ' · recovery' : ''}`, row.count])}/><SecurityCard title="Repository keyrings" icon={ShieldCheck} rows={(security.codebaseKeyrings ?? []).map((row: Json) => [row.rotationState, row.count])}/><SecurityCard title="Invitations" icon={UserPlus} rows={Object.entries(security.invitations ?? {})}/></div>
}

function SecurityCard({ title, icon: Icon, rows }: { title: string; icon: React.ComponentType<{ className?: string }>; rows: Array<[unknown, unknown]> }) {
  return <Card><CardHeader className="flex-row items-center gap-3"><Icon className="size-4 text-muted-foreground"/><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-2 pt-3">{rows.map(([label, value]) => <div key={String(label)} className="flex justify-between text-sm"><span className="capitalize text-muted-foreground">{String(label).replaceAll('_', ' ')}</span><span className="font-mono">{number(value)}</span></div>)}{!rows.length ? <p className="text-sm text-muted-foreground">No records.</p> : null}</CardContent></Card>
}

function AuditLedger({ data }: { data: Json }) {
  return <div className="grid items-start gap-4 xl:grid-cols-2"><EventPanel events={data.recentEvents ?? []} adminEvents={data.adminEvents ?? []}/><Card><CardHeader><CardTitle>Owner actions</CardTitle><p className="text-xs text-muted-foreground">Full retained console audit window.</p></CardHeader><CardContent className="space-y-1 pt-3">{(data.adminEvents ?? []).map((event: Json) => <div key={event.event_id} className="grid grid-cols-[1fr_auto] gap-3 border-b border-border py-2 last:border-0"><div className="min-w-0"><p className="truncate text-sm font-medium capitalize">{String(event.action).replaceAll('_', ' ')}</p><p className="truncate font-mono text-[11px] text-muted-foreground">{event.target_type} · {event.target_id}</p></div><span className="text-[11px] text-muted-foreground">{absoluteDateTime(event.created_at)}</span></div>)}</CardContent></Card></div>
}

function TenantDetailDialog({ tenant, data, onClose, onAction }: { tenant: Json | null; data: Json | null; onClose: () => void; onAction: (action: PendingAction) => void }) {
  if (!tenant) return null
  const repos = (data?.codebases ?? []).filter((repo: Json) => repo.tenantId === tenant.tenantId)
  const sessions = (data?.sessions ?? []).filter((session: Json) => session.tenantId === tenant.tenantId)
  const devices = (data?.devices ?? []).filter((device: Json) => device.tenantId === tenant.tenantId)
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={tenant.displayName || tenant.email || 'Tenant'} description={tenant.email || tenant.tenantId} className="max-w-5xl" footer={<><Button variant="outline" onClick={onClose}>Close</Button><TenantActions tenant={tenant} onAction={onAction}/></>}>
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Metric label="Plan" value={planName(tenant.plan)}/><Metric label="Storage" value={`${bytes(number(tenant.quota?.storage?.used))} / ${bytes(number(tenant.quota?.storage?.limit))}`}/><Metric label="Writes today" value={`${compact(tenant.quota?.dailyWrites?.used)} / ${compact(tenant.quota?.dailyWrites?.limit)}`}/><Metric label="Member since" value={tenant.userCreatedAt ? absoluteDate(tenant.userCreatedAt) : 'Unknown'}/></div>
      {tenant.writesPaused ? <InlineNotice tone="danger" title="Cloud writes paused" detail={tenant.pauseReason || 'No operator note was recorded.'}/> : null}
      <div className="grid gap-4 lg:grid-cols-3"><DetailList title="Repositories" rows={repos.map((repo: Json) => ({ title: repo.name, detail: `${repo.fileCount} files · revision ${repo.revision} · ${relative(repo.updatedAt)}` }))}/><DetailList title="Sessions" rows={sessions.map((session: Json) => ({ title: session.deviceName || session.sessionId, detail: `${session.status} · ${session.codebaseName} · ${relative(session.lastSeenAt)}` }))}/><DetailList title="Devices" rows={devices.map((device: Json) => ({ title: device.displayName || device.deviceId, detail: `${device.status} · ${device.platform || 'unknown'} · ${device.lastSeenAt ? relative(device.lastSeenAt) : 'never seen'}` }))}/></div>
      {tenant.subscription ? <div className="rounded-md border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">Stripe subscription</p><p className="font-mono text-[11px] text-muted-foreground">{tenant.subscription.providerSubscriptionId}</p></div><div className="flex gap-2"><Badge tone={tenant.subscription.entitlementActive ? 'hop' : 'danger'}>{tenant.subscription.status}</Badge>{tenant.subscription.providerSubscriptionId ? <Button asChild variant="outline" size="sm"><a href={stripeSubscriptionUrl(tenant.subscription.providerSubscriptionId)} target="_blank" rel="noreferrer"><ExternalLink/>Stripe</a></Button> : null}</div></div></div> : null}
    </div>
  </Dialog>
}

function DetailList({ title, rows }: { title: string; rows: Array<{ title: string; detail: string }> }) {
  return <div className="rounded-md border border-border p-3"><p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p><div className="space-y-2">{rows.slice(0, 12).map((row, index) => <div key={`${row.title}-${index}`}><p className="truncate text-sm font-medium">{row.title}</p><p className="truncate text-[11px] text-muted-foreground">{row.detail}</p></div>)}{!rows.length ? <p className="text-sm text-muted-foreground">None</p> : null}</div></div>
}

function TenantTable({ tenants, query, onQueryChange, onOpen, onAction }: {
  tenants: Json[]
  query: string
  onQueryChange: (value: string) => void
  onOpen: (tenantId: string) => void
  onAction: (action: PendingAction) => void
}) {
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
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => onOpen(tenant.tenantId)}>Inspect</Button>
                    <TenantActions tenant={tenant} onAction={onAction} />
                  </div>
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
  const active = sessions.filter((session) => session.status === 'active'
    && (!session.expiresAt || Date.parse(session.expiresAt) > Date.now()))
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
            <Button variant="ghost" size="sm" onClick={() => onRevoke({ action: 'revoke_session', targetId: session.sessionId, targetType: 'session', label: 'Device session revoked' })}>Revoke</Button>
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

function actionDescription(pending: PendingAction | null) {
  if (!pending) return undefined
  if (pending.action === 'pause_tenant_writes') return 'Cloud writes will pause. Reads, exports, deletes that free storage, and local journals remain available.'
  if (pending.action === 'resume_tenant_writes') return 'Cloud writes will resume under the tenant’s normal plan limits.'
  if (pending.action === 'revoke_session') return 'This session will be revoked and the device must authenticate again before it can sync.'
  if (pending.action === 'revoke_tenant_sessions') return 'Every active session for this tenant will be revoked.'
  if (pending.action === 'revoke_device') return 'The device key, linked sessions, and pending pairing attempts will be revoked.'
  if (pending.action === 'expire_device_authorization') return 'This pending device pairing request will be expired immediately.'
  if (pending.action === 'cancel_action_job') return 'This queued hosted action will be canceled before a runner claims it.'
  if (pending.action === 'requeue_action_job') return 'This failed hosted action will be placed back in the runner queue.'
  if (pending.action === 'reconcile_billing') return 'Stripe will be compared with every stored entitlement. Tenant plans may change to match the provider state.'
  return pending.cancelAtPeriodEnd ? 'The subscription will stop renewing at the end of its current paid period.' : 'Automatic renewal will resume for the next billing period.'
}

function safeAction(pending: PendingAction | null) {
  return pending?.action === 'resume_tenant_writes'
    || (pending?.action === 'set_subscription_cancellation' && pending.cancelAtPeriodEnd === false)
}

function actionBody(pending: PendingAction, reason: string) {
  const target = pending.targetType === 'tenant'
    ? { tenantId: pending.targetId }
    : pending.targetType === 'session'
      ? { sessionId: pending.targetId }
      : pending.targetType === 'device'
        ? { deviceId: pending.targetId }
        : pending.targetType === 'authorization'
          ? { authorizationId: pending.targetId }
          : pending.targetType === 'job'
            ? { jobId: pending.targetId }
            : {}
  return {
    action: pending.action,
    ...target,
    ...(pending.action === 'pause_tenant_writes' ? { reason } : {}),
    ...(pending.action === 'set_subscription_cancellation' ? { cancelAtPeriodEnd: pending.cancelAtPeriodEnd === true } : {}),
    confirmation: pending.targetId,
  }
}

function ConfirmationTarget({ target }: { target?: string }) {
  return <p className="rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-muted-foreground break-all">{target}</p>
}

function stripeSubscriptionUrl(subscriptionId: string) {
  return `https://dashboard.stripe.com/subscriptions/${encodeURIComponent(subscriptionId)}`
}

function planName(value: unknown) {
  return value === 'paid_storage' ? 'Plus Storage' : value === 'paid' ? 'Plus' : 'Free'
}

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function percent(value: unknown) { return `${Math.round(number(value) * 100)}%` }
function compact(value: unknown) { return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(number(value)) }
function usd(value: unknown) { return Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number(value)) }
function bytes(value: number) { if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`; if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`; return `${(value / 1_000_000_000).toFixed(2)} GB` }
function relative(value: unknown) { const at = Date.parse(String(value ?? '')); if (!Number.isFinite(at)) return 'unknown'; const delta = Date.now() - at; if (delta < 60_000) return 'just now'; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return `${Math.floor(delta / 86_400_000)}d ago` }
function absoluteDate(value: unknown) { const date = new Date(String(value ?? '')); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown' }
function absoluteDateTime(value: unknown) { const date = new Date(String(value ?? '')); return Number.isFinite(date.getTime()) ? date.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown' }
