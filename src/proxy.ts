import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { shouldBypassClerkForAgentToken } from '@/lib/agent-session-token'
import {
  isClerkServerConfigured,
  isHostedRuntime,
  shouldAllowBasicAuthFallback,
  shouldUseClerkAuth,
  signInPath,
} from '@/lib/auth-config'
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import { signInUrlForRequest } from '@/lib/safe-redirect'

const AUTH_HEADER = 'WWW-Authenticate'
const REALM = 'Basic realm="HopIt"'
const isPublicRoute = createRouteMatcher([
  '/',
  '/download',
  '/privacy',
  '/terms',
  '/sign-in(.*)',
  '/sign-up(.*)',
])
const isPublicMetadataRoute = createRouteMatcher(['/robots.txt', '/sitemap.xml'])
const isProtectedPageRoute = createRouteMatcher([
  '/activity(.*)',
  '/admin(.*)',
  '/codebases(.*)',
  '/device(.*)',
  '/files(.*)',
  '/members(.*)',
  '/overview(.*)',
  '/pricing(.*)',
  '/review(.*)',
  '/settings(.*)',
  '/status(.*)',
  '/team(.*)',
])
const isApiRoute = createRouteMatcher(['/api(.*)'])
const isClerkInternalRoute = createRouteMatcher(['/__clerk(.*)'])
// The one-liner installer (`curl -fsSL https://hopit.dev/install | sh`) must
// return the raw script to unauthenticated clients in every auth mode, so it is
// always public. `/install` is rewritten to the static `/install.sh` file.
const isInstallRoute = createRouteMatcher(['/install', '/install.sh'])
const isPublicDownloadRoute = createRouteMatcher(['/api/download(.*)'])
// Device-code creation and polling are intentionally public. Approval lives on
// a separate Clerk-protected route and requires the signed-in user.
const isPublicDeviceAuthorizationRoute = createRouteMatcher(['/api/device-authorizations'])
// Stripe webhooks and the Vercel reconcile cron authenticate inside their
// route handlers (signature verification and CRON_SECRET respectively). They
// must reach those handlers without an ambient Clerk browser session.
const isServerAuthenticatedBillingRoute = createRouteMatcher([
  '/api/billing/webhook',
  '/api/billing/reconcile',
])

const clerkProxy = clerkMiddleware(async (auth, request) => {
  await auth.protect({ unauthenticatedUrl: signInUrlForRequest(request.url, signInPath).toString() })
  return NextResponse.next()
})

// Public pages still pass through Clerk middleware so Server Components can
// read an existing session without requiring authentication.
const clerkPublicProxy = clerkMiddleware(() => NextResponse.next())

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (
    isPublicMetadataRoute(request)
    || isInstallRoute(request)
    || isPublicDownloadRoute(request)
    || isPublicDeviceAuthorizationRoute(request)
    || isServerAuthenticatedBillingRoute(request)
  ) return NextResponse.next()

  const publicPage = isPublicRoute(request)
  const clerkInternal = isClerkInternalRoute(request)
  const protectedRequest = isProtectedPageRoute(request) || isApiRoute(request)

  if (shouldUseClerkAuth()) {
    if (!isClerkServerConfigured()) {
      return publicPage || clerkInternal || protectedRequest ? authProviderMissing() : NextResponse.next()
    }
    if (publicPage || clerkInternal) return clerkPublicProxy(request, event)
    if (!protectedRequest) return NextResponse.next()
    if (hasValidBasicAuthFallbackCredentials(request.headers)) {
      return NextResponse.next()
    }
    // Agent session tokens ("hst_"-prefixed) are explicit credentials for the
    // /api surface. Step aside so the request reaches its route handler, where
    // cloudActorFromRequest performs the REAL validation (lookup / revocation /
    // expiry / codebase scope) and returns a JSON 4xx envelope on failure.
    // never a sign-in redirect. The middleware only recognizes the token shape;
    // it does NOT validate it (no D1 access in the edge runtime). This is scoped
    // to /api only, so pages keep full Clerk protection even with an hst_ header.
    // Precedence: for /api, an agent token wins over an ambient Clerk cookie.
    // explicit credentials beat ambient ones, and cloudActorFromRequest reads
    // the agent token before falling back to the Clerk session, so the outcome
    // is deterministic.
    if (shouldBypassClerkForAgentToken(request)) return NextResponse.next()
    return clerkProxy(request, event)
  }

  if (!protectedRequest || !shouldRequireDashboardAuth()) return NextResponse.next()
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
