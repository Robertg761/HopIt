import { SignUp } from '@clerk/nextjs'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { shouldEnableClerkUi, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignUpPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing title="Sign-up setup required" />

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_0.95fr]">
      <section className="signal-sheen relative hidden overflow-hidden bg-[var(--sidebar)] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <HopItLogo size={38} />
        <div className="relative z-10 max-w-xl">
          <p className="mono-label mb-5 text-[var(--signal)]">Start the relay</p>
          <h1 className="font-display text-7xl leading-[0.88] tracking-[-0.055em]">Your code is already where you&apos;re going.</h1>
          <p className="mt-7 max-w-md text-base leading-7 text-[var(--sidebar-muted)]">Create one cloud workspace and keep every device light, current, and ready to work.</p>
        </div>
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-[var(--sidebar-muted)]">HopIt workspace relay / 2026</p>
      </section>
      <section className="flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-7 lg:hidden"><HopItLogo size={34} /></div>
        <p className="mono-label mb-5 text-muted-foreground">Build your first workspace</p>
        <SignUp routing="path" path={signUpPath} signInUrl={signInPath} />
        <p className="mt-6 max-w-xs text-center text-xs leading-5 text-muted-foreground">Cloud-native continuity without the clone choreography.</p>
      </section>
    </main>
  )
}
