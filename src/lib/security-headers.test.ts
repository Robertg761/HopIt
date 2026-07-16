import { describe, expect, it } from 'vitest'

import { browserSecurityHeaders } from './security-headers'

describe('browser security headers', () => {
  it('sets the expected browser protections', () => {
    const headers = new Map(browserSecurityHeaders.map(({ key, value }) => [key, value]))

    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(headers.get('Content-Security-Policy')).toContain("object-src 'none'")
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })
})
