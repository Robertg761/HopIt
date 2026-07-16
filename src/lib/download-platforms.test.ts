import { describe, expect, it } from 'vitest'

import { downloadPlatforms } from './download-platforms'

describe('downloadPlatforms', () => {
  it('always offers manual macOS and Linux choices', () => {
    expect(downloadPlatforms.map((platform) => platform.architecture)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
    ])
    expect(downloadPlatforms.filter((platform) => platform.target.startsWith('macOS')).every((platform) => platform.href === '/api/download/macos?format=dmg')).toBe(true)
    expect(downloadPlatforms.every((platform) => platform.href.startsWith('/api/download/'))).toBe(true)
  })
})
