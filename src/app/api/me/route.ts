import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { shouldUseClerkAuth } from '@/lib/auth-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!shouldUseClerkAuth()) {
    return NextResponse.json(
      {
        authProvider: 'none',
        user: null,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const authState = await auth()
  if (!authState.userId) {
    return NextResponse.json(
      {
        authProvider: 'clerk',
        user: null,
      },
      {
        status: 401,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const user = await currentUser()

  return NextResponse.json(
    {
      authProvider: 'clerk',
      user: {
        id: authState.userId,
        sessionId: authState.sessionId,
        name: user?.fullName ?? user?.username ?? null,
        email: user?.primaryEmailAddress?.emailAddress ?? null,
        imageUrl: user?.imageUrl ?? null,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
