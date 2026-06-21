import { NextResponse } from 'next/server'
import { isConvexConfigured, readConvexAgentDashboard } from '@/lib/convex-agent'
import { shouldUseClerkAuth } from '@/lib/auth-config'
import { auth } from '@clerk/nextjs/server'

export const dynamic = 'force-dynamic'

const agentBaseUrl = process.env.HOPIT_AGENT_BASE_URL ?? 'http://127.0.0.1:4785'

export async function GET() {
  const missingHostedConfig = requiredHostedConfigMissing()
  if (missingHostedConfig.length > 0) {
    return NextResponse.json(
      {
        status: null,
        error: {
          code: 'hosted_config_missing',
          message: `Hosted HopIt requires Convex-backed status. Missing: ${missingHostedConfig.join(', ')}.`,
          missing: missingHostedConfig,
        },
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  if (isConvexConfigured()) {
    try {
      const requester = await readRequester()

      return NextResponse.json(
        {
          ...(await readConvexAgentDashboard(requester)),
          capabilities: agentCapabilities('convex'),
        },
        {
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Convex status error'

      return NextResponse.json(
        {
          status: null,
          error: {
            code: 'convex_unavailable',
            message,
          },
        },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      )
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)

  try {
    const [status, events, cloud] = await Promise.all([
      readAgentEndpoint('status', controller.signal),
      readAgentEndpoint('events', controller.signal),
      readAgentEndpoint('cloud', controller.signal),
    ])

    return NextResponse.json(
      {
        status,
        events,
        cloud,
        capabilities: agentCapabilities('local-agent'),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown agent connection error'

    return NextResponse.json(
      {
        status: null,
        error: {
          code: 'agent_unavailable',
          message,
          agentBaseUrl,
        },
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function readRequester() {
  if (!shouldUseClerkAuth()) return {}

  const { userId, sessionId } = await auth()
  return {
    requesterUserId: userId,
    requesterSessionId: sessionId,
  }
}

async function readAgentEndpoint(endpoint: string, signal: AbortSignal) {
  const response = await fetch(`${agentBaseUrl}/${endpoint}`, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`Agent ${endpoint} endpoint returned ${response.status}.`)
  }

  return response.json()
}

function requiredHostedConfigMissing() {
  if (!isHostedRuntime()) return []

  const missing: string[] = []
  if (!process.env.HOPIT_CODEBASE_ID) missing.push('HOPIT_CODEBASE_ID')
  if (!process.env.HOPIT_AGENT_TOKEN) missing.push('HOPIT_AGENT_TOKEN')
  if (!isConvexConfigured()) missing.push('HOPIT_CONVEX_URL or NEXT_PUBLIC_CONVEX_URL')

  return missing
}

function isHostedRuntime() {
  return process.env.VERCEL === '1' || process.env.HOPIT_REQUIRE_CONVEX === '1'
}

function agentCapabilities(backend: 'convex' | 'local-agent') {
  return {
    backend,
    hosted: isHostedRuntime(),
    commands: !isHostedRuntime() && backend === 'local-agent',
  }
}
