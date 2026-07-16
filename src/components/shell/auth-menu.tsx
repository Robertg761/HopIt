'use client'

import { SignInButton, UserButton, useUser } from '@clerk/nextjs'
import { LogIn, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useClerkAuthEnabled } from '@/components/providers/clerk-auth-provider'

export function AuthMenu() {
  const clerkEnabled = useClerkAuthEnabled()

  if (!clerkEnabled) {
    return (
      <span
        className="grid size-8 place-items-center rounded-full text-muted-foreground ring-1 ring-border"
        title="Authentication is not configured for this runtime"
        role="img"
        aria-label="Authentication is not configured for this runtime"
      >
        <ShieldAlert className="size-4" aria-hidden />
      </span>
    )
  }

  return <ConfiguredAuthMenu />
}

function ConfiguredAuthMenu() {
  const { isLoaded, isSignedIn } = useUser()

  if (!isLoaded) {
    return <div className="size-8 animate-pulse rounded-full bg-muted" />
  }

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <Button size="sm">
          <LogIn aria-hidden />
          Sign in
        </Button>
      </SignInButton>
    )
  }

  return (
    <UserButton
      appearance={{
        elements: {
          userButtonAvatarBox: 'size-8',
        },
      }}
    />
  )
}
