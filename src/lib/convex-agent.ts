import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'

export function isConvexConfigured() {
  return Boolean(convexUrl())
}

export type ConvexDashboardRequester = {
  requesterUserId?: string | null
  requesterSessionId?: string | null
}

export async function readConvexAgentDashboard(
  requester: ConvexDashboardRequester = {},
  codebaseId = process.env.HOPIT_CODEBASE_ID ?? 'hopit',
) {
  const url = convexUrl()
  if (!url) {
    throw new Error('Convex is not configured. Set HOPIT_CONVEX_URL or CONVEX_URL.')
  }

  const client = new ConvexHttpClient(url, { logger: false })
  const args: { codebaseId: string; token?: string; requesterUserId?: string; requesterSessionId?: string } = {
    codebaseId,
  }
  if (process.env.HOPIT_AGENT_TOKEN) args.token = process.env.HOPIT_AGENT_TOKEN
  if (requester.requesterUserId) args.requesterUserId = requester.requesterUserId
  if (requester.requesterSessionId) args.requesterSessionId = requester.requesterSessionId

  return client.query(anyApi.agent.dashboard, args)
}

function convexUrl() {
  return process.env.HOPIT_CONVEX_URL ?? process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL
}
