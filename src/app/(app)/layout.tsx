import { auth } from '@clerk/nextjs/server'
import { headers } from 'next/headers'

import { ClerkAuthProvider } from '@/components/providers/clerk-auth-provider'
import { AppShell } from '@/components/shell/app-shell'
import { shouldEnableClerkUi } from '@/lib/auth-config'
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import { currentServiceAdmin } from '@/lib/service-admin'

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const clerkEnabled = shouldEnableClerkUi()
  if (clerkEnabled && !hasValidBasicAuthFallbackCredentials(await headers())) {
    const session = await auth()
    if (!session.userId) return session.redirectToSignIn()
  }

  const serviceAdmin = clerkEnabled ? Boolean(await currentServiceAdmin()) : false
  return (
    <ClerkAuthProvider enabled={clerkEnabled}>
      <AppShell serviceAdmin={serviceAdmin}>{children}</AppShell>
    </ClerkAuthProvider>
  )
}
