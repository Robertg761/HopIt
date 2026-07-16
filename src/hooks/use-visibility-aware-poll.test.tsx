// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useVisibilityAwarePoll } from './use-visibility-aware-poll'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useVisibilityAwarePoll', () => {
  it('pauses while hidden and refreshes when the document becomes visible', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const callback = vi.fn()

    renderHook(() => useVisibilityAwarePoll(callback, { intervalMs: 1000 }))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(callback).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(callback).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(callback).toHaveBeenCalledTimes(2)
  })
})
