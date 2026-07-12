import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import {
  agentSessionTokenFromHeaders,
  shouldBypassClerkForAgentToken,
} from './agent-session-token'

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://app.test${path}`, { headers })
}

describe('agentSessionTokenFromHeaders', () => {
  it('reads a well-shaped token from the dedicated header', () => {
    const headers = new Headers({ 'x-hopit-agent-session-token': 'hst_abc123' })
    expect(agentSessionTokenFromHeaders(headers)).toBe('hst_abc123')
  })

  it('reads a well-shaped token from an Authorization: Bearer header', () => {
    const headers = new Headers({ authorization: 'Bearer hst_abc123' })
    expect(agentSessionTokenFromHeaders(headers)).toBe('hst_abc123')
  })

  it('is case-insensitive on the Bearer scheme and trims surrounding whitespace', () => {
    const headers = new Headers({ authorization: '  bearer   hst_trimmed  ' })
    expect(agentSessionTokenFromHeaders(headers)).toBe('hst_trimmed')
  })

  it('prefers the dedicated header over Authorization when both are present', () => {
    const headers = new Headers({
      'x-hopit-agent-session-token': 'hst_dedicated',
      authorization: 'Bearer hst_bearer',
    })
    expect(agentSessionTokenFromHeaders(headers)).toBe('hst_dedicated')
  })

  it('returns null for a malformed prefix (no underscore)', () => {
    expect(agentSessionTokenFromHeaders(new Headers({ authorization: 'Bearer hstgarbage' }))).toBeNull()
    expect(agentSessionTokenFromHeaders(new Headers({ 'x-hopit-agent-session-token': 'hs_garbage' }))).toBeNull()
  })

  it('returns null for a Basic Authorization header', () => {
    const headers = new Headers({ authorization: 'Basic aG9waXQ6c2VjcmV0' })
    expect(agentSessionTokenFromHeaders(headers)).toBeNull()
  })

  it('returns null when no token header is present', () => {
    expect(agentSessionTokenFromHeaders(new Headers())).toBeNull()
  })
})

describe('shouldBypassClerkForAgentToken', () => {
  it('bypasses for an /api request carrying a well-shaped token (dedicated header)', () => {
    expect(
      shouldBypassClerkForAgentToken(
        request('/api/codebase-files', { 'x-hopit-agent-session-token': 'hst_abc' }),
      ),
    ).toBe(true)
  })

  it('bypasses for an /api request carrying a well-shaped Bearer token', () => {
    expect(
      shouldBypassClerkForAgentToken(request('/api/codebases/compare', { authorization: 'Bearer hst_abc' })),
    ).toBe(true)
  })

  it('does NOT bypass an /api request without any token', () => {
    expect(shouldBypassClerkForAgentToken(request('/api/codebase-files'))).toBe(false)
  })

  it('does NOT bypass a non-/api page even when it carries a token', () => {
    expect(
      shouldBypassClerkForAgentToken(request('/dashboard', { 'x-hopit-agent-session-token': 'hst_abc' })),
    ).toBe(false)
  })

  it('does NOT bypass a look-alike path that merely starts with the /api substring', () => {
    expect(
      shouldBypassClerkForAgentToken(request('/apidocs', { 'x-hopit-agent-session-token': 'hst_abc' })),
    ).toBe(false)
  })

  it('does NOT bypass an /api request whose token has a malformed prefix', () => {
    expect(
      shouldBypassClerkForAgentToken(request('/api/codebase-files', { authorization: 'Bearer hstgarbage' })),
    ).toBe(false)
  })
})
