import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  isClerkServerConfigured,
  isHostedRuntime,
  shouldAllowBasicAuthFallback,
  shouldUseClerkAuth,
  signInPath,
} from '@/lib/auth-config'

const AUTH_HEADER = 'WWW-Authenticate'
const REALM = 'Basic realm="HopIt"'
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])

const clerkProxy = clerkMiddleware(async (auth, request) => {
  if (isPublicRoute(request)) return NextResponse.next()

  await auth.protect({ unauthenticatedUrl: new URL(signInPath, request.url).toString() })
  return NextResponse.next()
})

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (shouldUseClerkAuth()) {
    if (!isClerkServerConfigured()) return authProviderMissing()
    if (!isPublicRoute(request) && shouldAllowBasicAuthFallback() && hasValidBasicCredentials(request)) {
      return NextResponse.next()
    }
    return clerkProxy(request, event)
  }

  if (!shouldRequireDashboardAuth()) return NextResponse.next()
  if (!shouldAllowBasicAuthFallback()) return authProviderMissing()

  if (!process.env.HOPIT_DASHBOARD_PASSWORD) {
    return new NextResponse('Hosted HopIt requires HOPIT_DASHBOARD_PASSWORD.', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  }

  if (hasValidBasicCredentials(request)) {
    return NextResponse.next()
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      [AUTH_HEADER]: REALM,
      'Cache-Control': 'no-store',
    },
  })
}

function hasValidBasicCredentials(request: NextRequest) {
  const expectedPassword = process.env.HOPIT_DASHBOARD_PASSWORD
  if (!expectedPassword) return false

  const expectedUsername = process.env.HOPIT_DASHBOARD_USERNAME ?? 'hopit'
  const credentials = readBasicCredentials(request.headers.get('authorization'))

  return Boolean(
    credentials &&
      credentials.username === expectedUsername &&
      credentials.password === expectedPassword,
  )
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
}

function shouldRequireDashboardAuth() {
  if (process.env.HOPIT_DISABLE_DASHBOARD_AUTH === '1') return false
  return isHostedRuntime() || process.env.HOPIT_REQUIRE_DASHBOARD_AUTH === '1'
}

function readBasicCredentials(header: string | null) {
  if (!header?.startsWith('Basic ')) return null

  try {
    const decoded = atob(header.slice('Basic '.length))
    const separator = decoded.indexOf(':')
    if (separator === -1) return null

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    }
  } catch {
    return null
  }
}

function authProviderMissing() {
  return new NextResponse('Hosted HopIt requires Clerk authentication configuration.', {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
