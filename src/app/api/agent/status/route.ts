import { NextResponse } from 'next/server'
import { isConvexConfigured, readConvexAgentDashboard } from '@/lib/convex-agent'
import { shouldUseClerkAuth } from '@/lib/auth-config'
import { auth } from '@clerk/nextjs/server'

export const dynamic = 'force-dynamic'

const agentBaseUrl = process.env.HOPIT_AGENT_BASE_URL ?? 'http://127.0.0.1:4785'
const localAgentTimeoutMs = 5000

export async function GET(request: Request) {
  const missingHostedConfig = requiredHostedConfigMissing()
  if (missingHostedConfig.length > 0) {
    return unavailableStatusResponse(
      'hosted_config_missing',
      `Hosted HopIt requires Convex-backed status. Missing: ${missingHostedConfig.join(', ')}.`,
      {
        missing: missingHostedConfig,
      },
    )
  }

  if (isConvexConfigured()) {
    try {
      const requester = await readRequester()
      const codebaseId = codebaseIdFromRequest(request)

      return NextResponse.json(
        {
          ...(await readConvexAgentDashboard(requester, codebaseId)),
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

      return unavailableStatusResponse('convex_unavailable', message)
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

    return unavailableStatusResponse('agent_unavailable', message, { agentBaseUrl })
  } finally {
    clearTimeout(timeout)
  }
}

function unavailableStatusResponse(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return NextResponse.json(
    {
      status: null,
      error: {
        code,
        message,
        ...details,
      },
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-HopIt-Status': 'unavailable',
      },
    },
  )
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
  if (!process.env.HOPIT_AGENT_TOKEN) missing.push('HOPIT_AGENT_TOKEN')
  if (!isConvexConfigured()) missing.push('HOPIT_CONVEX_URL or NEXT_PUBLIC_CONVEX_URL')

  return missing
}

function codebaseIdFromRequest(request: Request) {
  const url = new URL(request.url)
  const requested = url.searchParams.get('codebaseId')?.trim()
  return requested || process.env.HOPIT_CODEBASE_ID || 'hopit'
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
