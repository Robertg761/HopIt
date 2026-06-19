import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const agentBaseUrl = process.env.HOPIT_AGENT_BASE_URL ?? 'http://127.0.0.1:4785'

export async function GET() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)

  try {
    const [status, events, cloud] = await Promise.all([
      readAgentEndpoint('status', controller.signal),
      readAgentEndpoint('events', controller.signal),
      readAgentEndpoint('cloud', controller.signal),
    ])

    return NextResponse.json({
      status,
      events,
      cloud,
    }, {
      headers: {
        'Cache-Control': 'no-store',
      },
    })
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
