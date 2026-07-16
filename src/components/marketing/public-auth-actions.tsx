import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { signedInHomePath } from '@/lib/auth-config'

export function PublicAuthActions({ signedIn = false }: { signedIn?: boolean }) {
  if (signedIn) {
    return (
      <Button asChild className="ml-auto sm:ml-0">
        <Link href={signedInHomePath}>Dashboard</Link>
      </Button>
    )
  }

  return (
    <>
      <Button asChild variant="ghost" className="ml-auto sm:ml-0">
        <Link href="/sign-in">Sign in</Link>
      </Button>
      <Button asChild className="hidden sm:inline-flex">
        <Link href="/sign-up">Start free</Link>
      </Button>
    </>
  )
}
