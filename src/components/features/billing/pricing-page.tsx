'use client'

import * as React from 'react'
import { ArrowRight, Check, Database, HardDrive, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { apiFetch, apiErrorFromUnknown } from '@/lib/client/api'
import { cn } from '@/lib/utils'

type PlanKey = 'free' | 'plus' | 'plus_storage'

type BillingStatus = {
  ok: boolean
  billingEnabled?: boolean
  subscription?: { planKey?: string; entitlementActive?: boolean } | null
  usage?: { plan?: string } | null
}

const plans = [
  {
    key: 'free' as const,
    name: 'Free',
    price: 0,
    storage: '2 GB',
    writes: '2,000 writes / day',
    projects: '1 cloud project',
    note: 'A real, permanent workspace. No card.',
  },
  {
    key: 'plus' as const,
    name: 'Plus',
    price: 10,
    storage: '30 GB',
    writes: '20,000 writes / day',
    projects: 'Unlimited projects',
    note: 'For active solo work across devices.',
    featured: true,
  },
  {
    key: 'plus_storage' as const,
    name: 'Plus Storage',
    price: 15,
    storage: '100 GB',
    writes: '20,000 writes / day',
    projects: 'Unlimited projects',
    note: 'For larger histories and more working sets.',
  },
]

export function PricingPage() {
  const [status, setStatus] = React.useState<BillingStatus | null>(null)
  const [busy, setBusy] = React.useState<PlanKey | 'portal' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [checkoutState, setCheckoutState] = React.useState<'success' | 'canceled' | null>(null)

  React.useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get('checkout')
    if (checkout === 'success' || checkout === 'canceled') setCheckoutState(checkout)
    apiFetch<BillingStatus>('/api/billing/status', { allowErrorEnvelope: true })
      .then(setStatus)
      .catch(() => setStatus({ ok: false }))
  }, [])

  const currentPlan: PlanKey = status?.subscription?.entitlementActive
    ? status.subscription.planKey === 'plus_storage' ? 'plus_storage' : 'plus'
    : 'free'

  async function beginCheckout(plan: 'plus' | 'plus_storage') {
    setBusy(plan)
    setError(null)
    try {
      const result = await apiFetch<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      })
      window.location.assign(result.url)
    } catch (cause) {
      setError(apiErrorFromUnknown(cause, 'Checkout could not be opened.').message)
      setBusy(null)
    }
  }

  async function openPortal() {
    setBusy('portal')
    setError(null)
    try {
      const result = await apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST' })
      window.location.assign(result.url)
    } catch (cause) {
      setError(apiErrorFromUnknown(cause, 'Subscription management is unavailable.').message)
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-10 shadow-sm sm:px-10 lg:px-14">
        <div className="pointer-events-none absolute -right-20 -top-28 size-80 rounded-full bg-iris/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            Pick the ceiling your work needs.
          </h1>
          <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
            HopIt pauses storage-growing syncs at the limit. Reads, exports, deletes, and your local journal stay available on every plan.
          </p>
        </div>
      </section>

      {checkoutState ? (
        <div className={cn(
          'mt-6 rounded-xl border px-4 py-3 text-sm',
          checkoutState === 'success' ? 'border-hop/30 bg-hop/10 text-foreground' : 'border-border bg-muted/40 text-muted-foreground',
        )}>
          {checkoutState === 'success'
            ? 'Payment received. Your plan will update as soon as Stripe confirms the subscription.'
            : 'Checkout was canceled. Nothing was charged.'}
        </div>
      ) : null}

      <section className="mt-8 grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => {
          const current = currentPlan === plan.key
          const paidAccount = currentPlan !== 'free'
          return (
            <article
              key={plan.key}
              className={cn(
                'relative flex min-h-[410px] flex-col rounded-2xl border bg-card p-6 shadow-sm transition-transform duration-200 hover:-translate-y-0.5',
                plan.featured ? 'border-iris/45 ring-1 ring-iris/15' : 'border-border',
              )}
            >
              <div>
                <h2 className="text-lg font-semibold text-foreground">{plan.name}</h2>
                <p className="mt-1 min-h-10 pr-20 text-sm leading-5 text-muted-foreground">{plan.note}</p>
              </div>
              <div className="mt-7 flex items-end gap-1">
                <span className="text-4xl font-semibold tracking-tight text-foreground">${plan.price}</span>
                <span className="pb-1 text-sm text-muted-foreground">USD / month</span>
              </div>
              <div className="my-6 h-px bg-border" />
              <ul className="space-y-3 text-sm text-foreground">
                {[plan.storage, plan.writes, plan.projects, 'Reads and full export always open'].map((feature) => (
                  <li key={feature} className="flex items-center gap-2.5">
                    <span className="grid size-5 place-items-center rounded-full bg-hop/10 text-hop"><Check className="size-3" /></span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-8">
                {current ? (
                  <Button className="w-full" variant="secondary" disabled>
                    Current plan
                  </Button>
                ) : plan.key === 'free' ? (
                  <Button className="w-full" variant="outline" disabled>
                    Included at signup
                  </Button>
                ) : paidAccount ? (
                  <Button className="w-full" variant={plan.featured ? 'default' : 'outline'} onClick={openPortal} disabled={busy !== null}>
                    {busy === 'portal' ? <Spinner className="size-4" /> : null}
                    Manage plan
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    variant={plan.featured ? 'default' : 'outline'}
                    onClick={() => beginCheckout(plan.key)}
                    disabled={busy !== null || status?.billingEnabled === false}
                  >
                    {busy === plan.key ? <Spinner className="size-4" /> : <ArrowRight className="size-4" />}
                    Upgrade to {plan.name}
                  </Button>
                )}
              </div>
            </article>
          )
        })}
      </section>

      {error ? <p className="mt-5 text-sm text-destructive">{error}</p> : null}
      {status?.billingEnabled === false ? (
        <p className="mt-5 text-sm text-muted-foreground">Checkout is being prepared. Free sync remains available while billing is off.</p>
      ) : null}

      <section className="mt-8 grid gap-4 rounded-2xl border border-border bg-muted/25 p-5 sm:grid-cols-3 sm:p-6">
        <PlanFact icon={HardDrive} title="Storage is a hard cap" detail="Upgrade before you need more; HopIt never creates an overage bill." />
        <PlanFact icon={Database} title="Writes reset daily" detail="We’ll monitor the 20,000-write allowance during early real-world testing." />
        <PlanFact icon={ShieldCheck} title="Your work stays yours" detail="A downgrade never deletes cloud data or touches the local journal." />
      </section>
    </div>
  )
}

function PlanFact({ icon: Icon, title, detail }: { icon: typeof HardDrive; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-iris"><Icon className="size-4" /></div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}
