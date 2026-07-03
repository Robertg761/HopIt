import { SignIn } from '@clerk/nextjs'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { shouldEnableClerkUi, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignInPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing />

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <HopItLogo size={34} />
      <SignIn routing="path" path={signInPath} signUpUrl={signUpPath} />
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Your code lives in the cloud. Every device stays a thin, synced view of it.
      </p>
    </main>
  )
}
