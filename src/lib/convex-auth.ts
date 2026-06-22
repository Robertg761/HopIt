import { auth } from '@clerk/nextjs/server'
import { ConvexHttpClient } from 'convex/browser'

import { shouldUseClerkAuth } from '@/lib/auth-config'

export async function convexAuthToken() {
  if (!shouldUseClerkAuth()) return null

  const authState = await auth()
  if (!authState.userId) return null

  return await authState.getToken({ template: convexJwtTemplate() })
}

export function convexClient(authToken?: string | null) {
  const url = convexUrl()
  if (!url) throw new Error('Convex is not configured. Set HOPIT_CONVEX_URL or CONVEX_URL.')

  const client = new ConvexHttpClient(url, { logger: false })
  if (authToken) client.setAuth(authToken)
  return client
}

export function isConvexConfigured() {
  return Boolean(convexUrl())
}

export function convexUrl() {
  return process.env.HOPIT_CONVEX_URL ?? process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL
}

function convexJwtTemplate() {
  return process.env.HOPIT_CLERK_CONVEX_JWT_TEMPLATE ?? 'convex'
}
