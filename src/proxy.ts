import { NextRequest, NextResponse } from 'next/server'

const AUTH_HEADER = 'WWW-Authenticate'
const REALM = 'Basic realm="HopIt"'

export function proxy(request: NextRequest) {
  if (!shouldRequireDashboardAuth()) return NextResponse.next()

  const expectedPassword = process.env.HOPIT_DASHBOARD_PASSWORD
  if (!expectedPassword) {
    return new NextResponse('Hosted HopIt requires HOPIT_DASHBOARD_PASSWORD.', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  }

  const expectedUsername = process.env.HOPIT_DASHBOARD_USERNAME ?? 'hopit'
  const credentials = readBasicCredentials(request.headers.get('authorization'))

  if (
    credentials &&
    credentials.username === expectedUsername &&
    credentials.password === expectedPassword
  ) {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)'],
}

function shouldRequireDashboardAuth() {
  if (process.env.HOPIT_DISABLE_DASHBOARD_AUTH === '1') return false
  return process.env.VERCEL === '1' || process.env.HOPIT_REQUIRE_DASHBOARD_AUTH === '1'
}

function readBasicCredentials(header: string | null) {
  if (!header?.startsWith('Basic ')) return null

  try {
    const decoded = atob(header.slice('Basic '.length))
    const separator = decoded.indexOf(':')
    if (separator === -1) return null

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    }
  } catch {
    return null
  }
}
