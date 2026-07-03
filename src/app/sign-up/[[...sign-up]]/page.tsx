import { SignUp } from '@clerk/nextjs'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { shouldEnableClerkUi, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignUpPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing title="Sign-up setup required" />

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <HopItLogo size={34} />
      <SignUp routing="path" path={signUpPath} signInUrl={signInPath} />
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Your code lives in the cloud. Every device stays a thin, synced view of it.
      </p>
    </main>
  )
}
