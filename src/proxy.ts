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
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'

const AUTH_HEADER = 'WWW-Authenticate'
const REALM = 'Basic realm="HopIt"'
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])
// The one-liner installer (`curl -fsSL https://hopit.dev/install | sh`) must
// return the raw script to unauthenticated clients in every auth mode, so it is
// always public. `/install` is rewritten to the static `/install.sh` file.
const isInstallRoute = createRouteMatcher(['/install', '/install.sh'])
// Device-code creation and polling are intentionally public. Approval lives on
// a separate Clerk-protected route and requires the signed-in user.
const isPublicDeviceAuthorizationRoute = createRouteMatcher(['/api/device-authorizations'])

const clerkProxy = clerkMiddleware(async (auth, request) => {
  await auth.protect({ unauthenticatedUrl: new URL(signInPath, request.url).toString() })
  return NextResponse.next()
})

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isInstallRoute(request) || isPublicDeviceAuthorizationRoute(request)) return NextResponse.next()

  if (shouldUseClerkAuth()) {
    if (!isClerkServerConfigured()) return authProviderMissing()
    if (isPublicRoute(request)) return NextResponse.next()
    if (hasValidBasicAuthFallbackCredentials(request.headers)) {
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

  if (hasValidBasicAuthFallbackCredentials(request.headers)) {
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

function authProviderMissing() {
  return new NextResponse('Hosted HopIt requires Clerk authentication configuration.', {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
