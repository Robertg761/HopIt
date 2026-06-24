import { SignIn } from '@clerk/nextjs'
import { AuthSetupMissing } from '@/components/hopit/auth-setup-missing'
import { shouldEnableClerkUi, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignInPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing />

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <SignIn routing="path" path={signInPath} signUpUrl={signUpPath} />
    </main>
  )
}
