import { auth, currentUser } from '@clerk/nextjs/server'
import { Clock3, Laptop, ShieldCheck } from 'lucide-react'

import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import {
  listCloudCodebases,
  readCloudDeviceAuthorization,
  upsertCloudUser,
  type CloudActor,
} from '@/lib/cloud-backend'
import { shouldEnableClerkUi } from '@/lib/auth-config'
import { DeviceApproval } from './device-approval'

export const dynamic = 'force-dynamic'

export default async function DeviceAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing title="Device authorization unavailable" />

  const { userId, sessionId } = await auth()
  const user = await currentUser()
  const actor: CloudActor | null = userId ? {
    userId,
    sessionId,
    primaryEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.username ?? null,
    avatarUrl: user?.imageUrl ?? null,
    currentAuthEmailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
  } : null
  const code = (await searchParams).code?.trim() ?? ''
  const authorization = code ? await readCloudDeviceAuthorization(code).catch(() => null) : null
  let codebases: Array<{ id: string; name: string }> = []
  if (actor) {
    await upsertCloudUser(actor)
    const rows = await listCloudCodebases(actor) as Array<Record<string, unknown>>
    codebases = rows.map(codebaseOption).filter((entry): entry is { id: string; name: string } => Boolean(entry))
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#f7faf8] px-4 py-10 text-[#17211b]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(26,127,55,0.12),transparent_32%),radial-gradient(circle_at_82%_78%,rgba(9,105,218,0.08),transparent_35%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(23,33,27,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(23,33,27,0.05)_1px,transparent_1px)] [background-size:32px_32px]" />

      <section className="relative w-full max-w-xl">
        <header className="mb-7 flex items-center justify-between">
          <HopItLogo size={30} className="text-[#17211b]" />
          <span className="rounded-full border border-[#cbd8cf] bg-white/80 px-3 py-1 font-mono text-[11px] font-medium text-[#506057] shadow-sm backdrop-blur">
            SECURE DEVICE LINK
          </span>
        </header>

        <div className="overflow-hidden rounded-2xl border border-[#cbd8cf] bg-white/92 shadow-[0_24px_80px_rgba(33,56,42,0.14)] backdrop-blur-xl">
          <div className="border-b border-[#dce5df] px-6 py-6 sm:px-8 sm:py-8">
            <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-[#dafbe1] text-[#116329] shadow-[inset_0_0_0_1px_rgba(17,99,41,0.08)]">
              <Laptop className="size-6" aria-hidden="true" />
            </div>
            <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1a7f37]">New device</p>
            <h1 className="font-display text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">Connect this device to HopIt</h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-[#5d6a62]">
              Review the device details, choose a project, and approve one encrypted session for your terminal.
            </p>
          </div>

          {!code ? (
            <StatePanel
              icon={<Clock3 className="size-5" />}
              title="Enter the link from your terminal"
              detail="Run hop setup again and open the authorization link it gives you."
            />
          ) : !authorization ? (
            <StatePanel
              icon={<Clock3 className="size-5" />}
              title="This code is not available"
              detail="It may have expired. Return to your terminal and run hop setup again."
            />
          ) : (
            <DeviceApproval
              userCode={authorization.userCode}
              initialStatus={authorization.status}
              device={authorization.device}
              expiresAt={authorization.expiresAt}
              codebases={codebases}
            />
          )}
        </div>

        <footer className="mt-5 flex items-center justify-center gap-2 text-xs text-[#66736b]">
          <ShieldCheck className="size-4 text-[#1a7f37]" aria-hidden="true" />
          The session token is encrypted for this device before it leaves HopIt Cloud.
        </footer>
      </section>
    </main>
  )
}

function StatePanel({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="flex gap-4 px-6 py-8 sm:px-8">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f0f4f1] text-[#506057]">{icon}</div>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-[#66736b]">{detail}</p>
      </div>
    </div>
  )
}

function codebaseOption(value: Record<string, unknown>) {
  const codebase = recordValue(value.codebase)
  const id = optionalText(codebase?.id) ?? optionalText(value.id)
  if (!id) return null
  return {
    id,
    name: optionalText(codebase?.name) ?? optionalText(value.name) ?? id,
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
