'use client'

import {
  SignInButton,
  UserButton,
  useUser,
} from '@clerk/nextjs'
import { LogIn, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useClerkAuthEnabled } from '@/website/components/clerk-auth-provider'

export function AuthMenu() {
  const clerkEnabled = useClerkAuthEnabled()

  if (!clerkEnabled) {
    return (
      <button
        className="ml-1 grid size-9 place-items-center rounded-full text-muted-foreground ring-1 ring-border"
        aria-label="Authentication disabled for this runtime"
        title="Authentication disabled for this runtime"
      >
        <ShieldAlert className="size-4" />
      </button>
    )
  }

  return <ConfiguredAuthMenu />
}

function ConfiguredAuthMenu() {
  const { isLoaded, isSignedIn } = useUser()

  if (!isLoaded) {
    return <div className="ml-1 size-9 rounded-full bg-muted/60 ring-1 ring-border" />
  }

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <Button size="sm" className="gap-1.5 rounded-lg bg-hop px-3 text-hop-foreground shadow-sm hover:bg-hop/90">
          <LogIn className="size-4" />
          Sign in
        </Button>
      </SignInButton>
    )
  }

  return <SignedInMenu />
}

function SignedInMenu() {
  const { user } = useUser()
  const displayName = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? 'HopIt user'
  const email = user?.primaryEmailAddress?.emailAddress ?? 'Signed in'

  return (
    <div className="ml-1 flex items-center gap-2">
      <div className="hidden min-w-0 text-right md:block">
        <p className="truncate text-xs font-medium">{displayName}</p>
        <p className="truncate text-[10.5px] text-muted-foreground">{email}</p>
      </div>
      <div className="rounded-full p-0.5 ring-1 ring-border hover:ring-hop/40">
        <UserButton
          appearance={{
            elements: {
              userButtonAvatarBox: 'size-8',
            },
          }}
        />
      </div>
    </div>
  )
}
