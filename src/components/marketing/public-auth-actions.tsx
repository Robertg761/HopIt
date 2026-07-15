'use client'

import { useAuth, UserButton } from '@clerk/nextjs'
import Link from 'next/link'

import { useClerkAuthEnabled } from '@/components/providers/clerk-auth-provider'
import { Button } from '@/components/ui/button'
import { signedInHomePath } from '@/lib/auth-config'

export function PublicAuthActions() {
  const clerkEnabled = useClerkAuthEnabled()

  if (!clerkEnabled) {
    return <SignedOutActions />
  }

  return <ClerkPublicAuthActions />
}

function ClerkPublicAuthActions() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded || !isSignedIn) return <SignedOutActions />

  return (
    <>
      <Button asChild className="ml-auto sm:ml-0">
        <Link href={signedInHomePath}>Dashboard</Link>
      </Button>
      <UserButton />
    </>
  )
}

function SignedOutActions() {
  return (
    <>
      <Button asChild variant="ghost" className="ml-auto sm:ml-0">
        <Link href="/sign-in">Sign in</Link>
      </Button>
      <Button asChild>
        <Link href="/sign-up">Start free</Link>
      </Button>
    </>
  )
}
