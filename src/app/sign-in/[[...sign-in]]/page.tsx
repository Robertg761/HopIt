import { SignIn } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { shouldEnableClerkUi, signedInHomePath, signInPath, signUpPath } from '@/lib/auth-config'

export default async function SignInPage() {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing />
  const { userId } = await auth()
  if (userId) redirect(signedInHomePath)

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
      <div className="mb-8">
        <HopItLogo size={32} />
      </div>
      <SignIn routing="path" path={signInPath} signUpUrl={signUpPath} fallbackRedirectUrl={signedInHomePath} />
    </main>
  )
}
