import { describe, expect, it } from 'vitest'

import { downloadKey } from './route'

describe('downloadKey', () => {
  it('accepts the versioned universal macOS DMG', () => {
    expect(downloadKey({
      downloads: { macos: { key: 'releases/0.0.1+abc/HopIt-macOS.dmg' } },
    }, 'macos', 'dmg')).toBe('releases/0.0.1+abc/HopIt-macOS.dmg')
  })

  it('keeps current target archives compatible', () => {
    expect(downloadKey({
      version: '0.0.1+abc',
      targets: { 'linux-x64': { key: 'latest/hop-linux-x64.tar.gz' } },
    }, 'linux-x64', 'archive')).toBe('latest/hop-linux-x64.tar.gz')
  })

  it('rejects an external manifest key', () => {
    expect(downloadKey({
      downloads: { macos: { key: 'https://example.com/HopIt-macOS.dmg' } },
    }, 'macos', 'dmg')).toBeNull()
  })
})
