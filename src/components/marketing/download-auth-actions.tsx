'use client'

import { useAuth } from '@clerk/nextjs'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'

import { useClerkAuthEnabled } from '@/components/providers/clerk-auth-provider'
import { Button } from '@/components/ui/button'
import { signedInHomePath } from '@/lib/auth-config'

export function DownloadDashboardButton() {
  const clerkEnabled = useClerkAuthEnabled()

  if (!clerkEnabled) return <DashboardButton href="/sign-in" />
  return <ClerkDashboardButton />
}

function ClerkDashboardButton() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) return <div className="mt-6 h-9" aria-hidden />
  return <DashboardButton href={isSignedIn ? signedInHomePath : '/sign-in'} />
}

function DashboardButton({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" className="mt-6">
      <Link href={href}>Open the web dashboard <ArrowRight /></Link>
    </Button>
  )
}
