import type { Metadata } from 'next'
import { SignUp } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { ClerkAuthProvider } from '@/components/providers/clerk-auth-provider'
import { shouldEnableClerkUi, signedInHomePath, signInPath, signUpPath } from '@/lib/auth-config'
import { authPathWithRedirect, safeRelativeRedirect } from '@/lib/safe-redirect'

export const metadata: Metadata = {
  title: 'Create account | HopIt',
  robots: { index: false, follow: false },
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>
}) {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing title="Sign-up setup required" />
  const destination = safeRelativeRedirect((await searchParams).redirect_url, signedInHomePath)
  const signInUrl = authPathWithRedirect(signInPath, destination)
  const { userId } = await auth()
  if (userId) redirect(destination)

  return (
    <ClerkAuthProvider enabled>
      <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
        <div className="mb-8">
          <HopItLogo size={32} />
        </div>
        <SignUp routing="path" path={signUpPath} signInUrl={signInUrl} fallbackRedirectUrl={destination} />
      </main>
    </ClerkAuthProvider>
  )
}
