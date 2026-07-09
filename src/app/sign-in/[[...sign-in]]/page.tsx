import { SignIn } from '@clerk/nextjs'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { shouldEnableClerkUi, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignInPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing />

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_0.95fr]">
      <section className="signal-sheen relative hidden overflow-hidden bg-[var(--sidebar)] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <HopItLogo size={38} />
        <div className="relative z-10 max-w-xl">
          <p className="mono-label mb-5 text-[var(--signal)]">One workspace / every device</p>
          <h1 className="font-display text-7xl leading-[0.88] tracking-[-0.055em]">Pick up exactly where you left off.</h1>
          <p className="mt-7 max-w-md text-base leading-7 text-[var(--sidebar-muted)]">No stale clones. No push-pull ritual. Just your code, already waiting where you need it.</p>
        </div>
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-[var(--sidebar-muted)]">HopIt workspace relay / 2026</p>
      </section>
      <section className="flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-7 lg:hidden"><HopItLogo size={34} /></div>
        <p className="mono-label mb-5 text-muted-foreground">Return to your relay</p>
        <SignIn routing="path" path={signInPath} signUpUrl={signUpPath} />
        <p className="mt-6 max-w-xs text-center text-xs leading-5 text-muted-foreground">One living codebase. Every device in step.</p>
      </section>
    </main>
  )
}
