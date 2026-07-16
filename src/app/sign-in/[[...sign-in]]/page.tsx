import type { Metadata } from 'next'
import { SignIn } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { HopItLogo } from '@/components/brand/logo'
import { AuthSetupMissing } from '@/components/auth/auth-setup-missing'
import { ClerkAuthProvider } from '@/components/providers/clerk-auth-provider'
import { shouldEnableClerkUi, signedInHomePath, signInPath, signUpPath } from '@/lib/auth-config'
import { authPathWithRedirect, safeRelativeRedirect } from '@/lib/safe-redirect'

export const metadata: Metadata = {
  title: 'Sign in | HopIt',
  robots: { index: false, follow: false },
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>
}) {
  if (!shouldEnableClerkUi()) return <AuthSetupMissing />
  const destination = safeRelativeRedirect((await searchParams).redirect_url, signedInHomePath)
  const signUpUrl = authPathWithRedirect(signUpPath, destination)
  const { userId } = await auth()
  if (userId) redirect(destination)

  return (
    <ClerkAuthProvider enabled>
      <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
        <div className="mb-8">
          <HopItLogo size={32} />
        </div>
        <SignIn routing="path" path={signInPath} signUpUrl={signUpUrl} fallbackRedirectUrl={destination} />
      </main>
    </ClerkAuthProvider>
  )
}
