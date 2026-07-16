import { describe, expect, it } from 'vitest'

import sitemap from './sitemap'

describe('sitemap metadata', () => {
  it('contains only indexable public pages', () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      'https://hopit.dev/',
      'https://hopit.dev/download',
      'https://hopit.dev/privacy',
      'https://hopit.dev/terms',
    ])
  })
})
