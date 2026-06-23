import { NextResponse } from 'next/server'
import { isConvexConfigured, readConvexAgentDashboard } from '@/lib/convex-agent'
import { shouldUseClerkAuth } from '@/lib/auth-config'
import { auth } from '@clerk/nextjs/server'

export const dynamic = 'force-dynamic'

const agentBaseUrl = process.env.HOPIT_AGENT_BASE_URL ?? 'http://127.0.0.1:4785'
const localAgentTimeoutMs = 5000

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
  const timeout = setTimeout(() => controller.abort(), localAgentTimeoutMs)

  try {
    const status = await readAgentEndpoint('status', controller.signal)
    const [events, cloud] = await Promise.allSettled([
      readAgentEndpoint('events', controller.signal),
      readAgentEndpoint('cloud', controller.signal),
    ])

    return NextResponse.json(
      {
        status,
        events: endpointValue(events),
        cloud: endpointValue(cloud),
        partialErrors: endpointErrors({ events, cloud }),
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

function endpointValue(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? result.value : null
}

function endpointErrors(results: Record<string, PromiseSettledResult<unknown>>) {
  const errors = Object.entries(results)
    .filter(([, result]) => result.status === 'rejected')
    .map(([endpoint, result]) => ({
      endpoint,
      message: result.status === 'rejected' && result.reason instanceof Error
        ? result.reason.message
        : `Agent ${endpoint} endpoint is unavailable.`,
    }))

  return errors.length > 0 ? errors : undefined
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
