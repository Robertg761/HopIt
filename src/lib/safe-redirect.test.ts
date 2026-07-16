import { describe, expect, it } from 'vitest'

import { authPathWithRedirect, safeRelativeRedirect, signInUrlForRequest } from './safe-redirect'

describe('safeRelativeRedirect', () => {
  it.each([
    '/overview',
    '/codebases/abc/pulls?thread=123',
    '/settings#billing',
  ])('accepts the relative path %s', (candidate) => {
    expect(safeRelativeRedirect(candidate, '/overview')).toBe(candidate)
  })

  it.each([
    null,
    undefined,
    '',
    'overview',
    '//evil.example/path',
    '/\\evil.example/path',
    'https://evil.example/path',
    '/path://evil.example',
    '/overview\nSet-Cookie: bad=1',
    `/${'x'.repeat(2048)}`,
  ])('rejects unsafe destination %s', (candidate) => {
    expect(safeRelativeRedirect(candidate, '/overview')).toBe('/overview')
  })
})

describe('signInUrlForRequest', () => {
  it('preserves the protected path and query string', () => {
    const url = signInUrlForRequest('https://hopit.dev/codebases/abc/pulls?thread=123', '/sign-in')
    expect(url.origin).toBe('https://hopit.dev')
    expect(url.pathname).toBe('/sign-in')
    expect(url.searchParams.get('redirect_url')).toBe('/codebases/abc/pulls?thread=123')
  })
})

describe('authPathWithRedirect', () => {
  it('preserves the destination while switching authentication screens', () => {
    expect(authPathWithRedirect('/sign-up', '/codebases/example/pulls?tab=open')).toBe(
      '/sign-up?redirect_url=%2Fcodebases%2Fexample%2Fpulls%3Ftab%3Dopen',
    )
  })
})
