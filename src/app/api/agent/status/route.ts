import { NextResponse } from 'next/server'
import { shouldUseClerkAuth } from '@/lib/auth-config'
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import { configuredCloudBackend, missingCloudBackendConfig, readCloudAgentDashboard } from '@/lib/cloud-backend'
import { auth } from '@clerk/nextjs/server'

export const dynamic = 'force-dynamic'

const agentBaseUrl = process.env.HOPIT_AGENT_BASE_URL ?? 'http://127.0.0.1:4785'
const localAgentTimeoutMs = 5000
const hostedCloudStatusCacheMs = 60_000
const hostedCloudStatusErrorCacheMs = 10_000
const hostedCloudStatusStaleMs = 5 * 60_000
const hostedCloudStatusCache = new Map<string, HostedCloudStatusCacheEntry>()

type HostedCloudStatusCacheEntry = {
  expiresAt: number
  staleUntil: number
  value?: Awaited<ReturnType<typeof readCloudAgentDashboard>>
  promise?: Promise<Awaited<ReturnType<typeof readCloudAgentDashboard>>>
}

export async function GET(request: Request) {
  const missingHostedConfig = requiredHostedConfigMissing()
  if (missingHostedConfig.length > 0) {
    return unavailableStatusResponse(
      'hosted_config_missing',
      `Hosted HopIt requires a cloud-backed status backend. Missing: ${missingHostedConfig.join(', ')}.`,
      {
        missing: missingHostedConfig,
      },
    )
  }

  const cloudBackend = configuredCloudBackend()
  if (cloudBackend !== 'unavailable') {
    try {
      const requester = await readRequester(request)
      const codebaseId = codebaseIdFromRequest(request)

      return NextResponse.json(
        {
          ...(await readHostedCloudAgentDashboard(requester, codebaseId, cloudBackend)),
          capabilities: agentCapabilities(cloudBackend),
        },
        {
          headers: {
            'Cache-Control': 'no-store',
          },
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown cloud status error'

      return unavailableStatusResponse('cloud_unavailable', message, {}, {
        capabilities: agentCapabilities(cloudBackend),
      })
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

async function readHostedCloudAgentDashboard(
  requester: Awaited<ReturnType<typeof readRequester>>,
  codebaseId: string,
  cloudBackend: ReturnType<typeof configuredCloudBackend>,
) {
  if (!isHostedRuntime()) return readCloudAgentDashboard(requester, codebaseId)

  const now = Date.now()
  const key = hostedCloudStatusCacheKey(requester, codebaseId, cloudBackend)
  const cached = hostedCloudStatusCache.get(key)
  if (cached?.value && cached.expiresAt > now) return cached.value
  if (cached?.promise) return cached.promise

  const entry: HostedCloudStatusCacheEntry = {
    expiresAt: now + hostedCloudStatusErrorCacheMs,
    staleUntil: cached?.staleUntil ?? 0,
    value: cached?.value,
  }
  entry.promise = readCloudAgentDashboard(requester, codebaseId)
    .then((value) => {
      entry.value = value
      entry.expiresAt = Date.now() + hostedCloudStatusCacheMs
      entry.staleUntil = Date.now() + hostedCloudStatusStaleMs
      return value
    })
    .catch((error) => {
      entry.expiresAt = Date.now() + hostedCloudStatusErrorCacheMs
      if (entry.value && entry.staleUntil > Date.now()) return entry.value
      throw error
    })
    .finally(() => {
      entry.promise = undefined
    })

  hostedCloudStatusCache.set(key, entry)
  return entry.promise
}

function hostedCloudStatusCacheKey(
  requester: Awaited<ReturnType<typeof readRequester>>,
  codebaseId: string,
  cloudBackend: ReturnType<typeof configuredCloudBackend>,
) {
  return [
    cloudBackend,
    codebaseId,
    requester.requesterUserId ?? 'anonymous',
    requester.requesterSessionId ?? 'no-session',
  ].join(':')
}

function unavailableStatusResponse(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
) {
  return NextResponse.json(
    {
      status: null,
      error: {
        code,
        message,
        ...details,
      },
      ...payload,
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

async function readRequester(request: Request) {
  if (!shouldUseClerkAuth()) return {}
  if (hasValidBasicAuthFallbackCredentials(request.headers)) return {}

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
  return missingCloudBackendConfig()
}

function codebaseIdFromRequest(request: Request) {
  const url = new URL(request.url)
  const requested = url.searchParams.get('codebaseId')?.trim()
  return requested || process.env.HOPIT_CODEBASE_ID || 'hopit'
}

function isHostedRuntime() {
  return process.env.VERCEL === '1' || process.env.HOPIT_REQUIRE_CONVEX === '1' || process.env.HOPIT_REQUIRE_CLOUD === '1'
}

function agentCapabilities(backend: 'd1' | 'convex' | 'local-agent' | 'unavailable') {
  return {
    backend,
    hosted: isHostedRuntime(),
    commands: !isHostedRuntime(),
  }
}
