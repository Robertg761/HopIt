import { SignUp } from '@clerk/nextjs'
import { AuthSetupMissing } from '@/components/hopit/auth-setup-missing'
import { isClerkPublicConfigured, signInPath, signUpPath } from '@/lib/auth-config'

export default function SignUpPage() {
  if (!isClerkPublicConfigured()) return <AuthSetupMissing title="Sign-up setup required" />

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <SignUp routing="path" path={signUpPath} signInUrl={signInPath} />
    </main>
  )
}
