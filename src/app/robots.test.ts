import { describe, expect, it } from 'vitest'

import robots from './robots'

describe('robots metadata', () => {
  it('publishes the sitemap and keeps private surfaces out of search', () => {
    const metadata = robots()
    expect(metadata.sitemap).toBe('https://hopit.dev/sitemap.xml')
    expect(metadata.rules).toEqual(expect.objectContaining({
      userAgent: '*',
      allow: expect.arrayContaining(['/', '/download', '/privacy', '/terms']),
      disallow: expect.arrayContaining(['/api/', '/overview', '/sign-in']),
    }))
  })
})
