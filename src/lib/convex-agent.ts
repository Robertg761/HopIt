import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'

export function isConvexConfigured() {
  return Boolean(convexUrl())
}

export async function readConvexAgentDashboard() {
  const url = convexUrl()
  if (!url) {
    throw new Error('Convex is not configured. Set HOPIT_CONVEX_URL or CONVEX_URL.')
  }

  const client = new ConvexHttpClient(url, { logger: false })
  const args: { codebaseId: string; token?: string } = {
    codebaseId: process.env.HOPIT_CODEBASE_ID ?? 'hopit',
  }
  if (process.env.HOPIT_AGENT_TOKEN) args.token = process.env.HOPIT_AGENT_TOKEN

  return client.query(anyApi.agent.dashboard, args)
}

function convexUrl() {
  return process.env.HOPIT_CONVEX_URL ?? process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL
}
