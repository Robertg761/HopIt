import type { Metadata } from 'next'
import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  ArrowRight,
  Check,
  Cloud,
  Download,
  HardDrive,
  Laptop,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

import { PublicShell } from '@/components/marketing/public-shell'
import { Button } from '@/components/ui/button'
import { shouldEnableClerkUi, signedInHomePath } from '@/lib/auth-config'
import { planCatalog } from '@/lib/billing-plans'

export const metadata: Metadata = {
  title: 'HopIt | Your code, already there',
  description: 'Cloud-native code workspaces that stay in sync across devices while preserving a local journal and a full export path.',
}

const plans = [
  { plan: planCatalog.free, projects: '1 cloud project', accent: false },
  { plan: planCatalog.plus, projects: 'Unlimited projects', accent: true },
  { plan: planCatalog.plus_storage, projects: 'Unlimited projects', accent: false },
].map(({ plan, projects, accent }) => ({
  name: plan.shortName,
  price: `$${plan.priceUsd}`,
  storage: `${plan.storageGb} GB`,
  writes: `${plan.dailyWrites.toLocaleString('en-US')} writes/day`,
  projects,
  accent,
}))

export default async function MarketingPage() {
  if (shouldEnableClerkUi()) {
    const { userId } = await auth()
    if (userId) redirect(signedInHomePath)
  }

  return (
    <PublicShell>
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="absolute inset-0 -z-20 bg-[linear-gradient(120deg,#f6f8fa_0%,#ffffff_48%,#eef7ff_100%)] dark:bg-[linear-gradient(120deg,#0d1117_0%,#0d1117_55%,#101a29_100%)]" />
        <div className="absolute inset-0 -z-10 opacity-50 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]" />
        <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1.08fr_.92fr] lg:items-center lg:px-8 lg:py-32">
          <div>
            <h1 className="max-w-3xl text-balance text-5xl font-semibold tracking-[-0.055em] sm:text-6xl lg:text-7xl">
              Your code,<br /><span className="text-hop">already there.</span>
            </h1>
            <p className="mt-7 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
              HopIt keeps cloud-native code workspaces synchronized across devices, with a durable local journal when the network or your plan limit gets in the way.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-11 px-5">
                <Link href="/sign-up">Create a free workspace <ArrowRight aria-hidden /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 px-5">
                <Link href="/download"><Download aria-hidden /> Download HopIt</Link>
              </Button>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[520px]">
            <div className="absolute -inset-5 -z-10 rounded-[32px] bg-iris/10 blur-3xl" />
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(31,35,40,.14)]">
              <div className="flex items-center gap-2 border-b border-border bg-muted/55 px-4 py-3">
                <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">continuity.log</span>
              </div>
              <div className="space-y-1 p-5 font-mono text-xs sm:p-7 sm:text-sm">
                <RelayLine icon={Laptop} time="09:14" label="MacBook" detail="saved src/sync.ts" tone="text-foreground" />
                <RelayStem />
                <RelayLine icon={Cloud} time="09:14" label="HopIt cloud" detail="revision 1842 acknowledged" tone="text-iris" />
                <RelayStem />
                <RelayLine icon={Laptop} time="09:15" label="Desktop" detail="workspace advanced to 1842" tone="text-hop" />
                <div className="mt-6 rounded-lg border border-border bg-muted/45 p-4 font-sans">
                  <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-hop" aria-hidden /> Continuity intact</div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Reads and exports stay open. Unsynced edits stay in your local journal until they can move safely.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="mx-auto w-full max-w-[1180px] px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:gap-20">
          <div>
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">The handoff becomes the default.</h2>
            <p className="mt-5 text-base leading-7 text-muted-foreground">Create a cloud project once. Attach any machine. HopIt reconciles the workspace while keeping the safety boundary local.</p>
          </div>
          <ol className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
            <Step icon={Cloud} title="Create" detail="Start with one free cloud project. No card and no owner approval." />
            <Step icon={Download} title="Attach" detail="Authorize a device with a scoped session. Storage credentials never live on the client." />
            <Step icon={RefreshCw} title="Continue" detail="Sync, switch devices, and recover held edits from the local journal." />
          </ol>
        </div>
      </section>

      <section className="border-y border-border bg-[#0d1117] text-[#f0f6fc]">
        <div className="mx-auto grid w-full max-w-[1180px] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-20">
          <div>
            <LockKeyhole className="size-8 text-[#3fb950]" aria-hidden />
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.03em]">Isolation is enforced below the UI.</h2>
            <p className="mt-4 max-w-xl leading-7 text-[#8b949e]">Tenant checks run at the database, session, and blob boundaries. Clients receive scoped sessions and brokered object access, not administrative storage keys.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <DarkFact icon={ShieldCheck} title="Tenant-scoped" detail="Cross-tenant SQL, session, and blob probes fail closed." />
            <DarkFact icon={HardDrive} title="Hard storage caps" detail="Writes pause at the ceiling; reads and exports remain open." />
            <DarkFact icon={RefreshCw} title="Local journal" detail="Blocked edits stay recoverable on the originating device." />
            <DarkFact icon={Download} title="Exit path" detail="Export your work instead of being trapped by the service." />
          </div>
        </div>
      </section>

      <section id="pricing" className="mx-auto w-full max-w-[1180px] px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="max-w-2xl">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">Choose a ceiling, not an overage meter.</h2>
        </div>
        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => (
            <article key={plan.name} className={`relative flex min-h-[330px] flex-col rounded-2xl border bg-card p-6 ${plan.accent ? 'border-hop ring-1 ring-hop/20 shadow-lg' : 'border-border'}`}>
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <div className="mt-6"><span className="text-4xl font-semibold tracking-tight">{plan.price}</span><span className="ml-1 text-sm text-muted-foreground">USD / month</span></div>
              <ul className="mt-7 space-y-3 text-sm">
                {[plan.storage, plan.writes, plan.projects, 'Reads and exports stay open'].map((item) => <li key={item} className="flex gap-2.5"><Check className="mt-0.5 size-4 text-hop" aria-hidden />{item}</li>)}
              </ul>
              <Button asChild className="mt-auto" variant={plan.accent ? 'default' : 'outline'}>
                <Link href="/sign-up">{plan.name === 'Free' ? 'Start free' : `Choose ${plan.name}`}</Link>
              </Button>
            </article>
          ))}
        </div>
      </section>
    </PublicShell>
  )
}

function RelayLine({ icon: Icon, time, label, detail, tone }: { icon: typeof Laptop; time: string; label: string; detail: string; tone: string }) {
  return <div className="grid grid-cols-[42px_28px_1fr] items-center gap-2"><span className="text-[10px] text-muted-foreground">{time}</span><span className="grid size-7 place-items-center rounded-full border border-border bg-background"><Icon className={`size-3.5 ${tone}`} aria-hidden /></span><span><strong className={tone}>{label}</strong><span className="text-muted-foreground"> · {detail}</span></span></div>
}

function RelayStem() {
  return <div className="ml-[55px] h-5 w-px bg-border" aria-hidden />
}

function Step({ icon: Icon, title, detail }: { icon: typeof Cloud; title: string; detail: string }) {
  return <li className="bg-card p-6"><Icon className="size-5 text-hop" aria-hidden /><h3 className="mt-12 text-lg font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p></li>
}

function DarkFact({ icon: Icon, title, detail }: { icon: typeof ShieldCheck; title: string; detail: string }) {
  return <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-5"><Icon className="size-4 text-[#58a6ff]" aria-hidden /><h3 className="mt-4 font-medium">{title}</h3><p className="mt-2 text-sm leading-6 text-[#8b949e]">{detail}</p></div>
}
