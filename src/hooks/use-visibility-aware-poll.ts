'use client'

import * as React from 'react'

type PollCallback = () => boolean | void | Promise<boolean | void>

export function useVisibilityAwarePoll(
  callback: PollCallback,
  {
    enabled = true,
    intervalMs,
    maxRuns,
    refreshOnVisible = true,
  }: {
    enabled?: boolean
    intervalMs: number
    maxRuns?: number
    refreshOnVisible?: boolean
  },
) {
  const callbackRef = React.useRef(callback)

  React.useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  React.useEffect(() => {
    if (!enabled) return
    let active = true
    let running = false
    let runs = 0
    let interval: number | undefined

    async function tick() {
      if (!active || running || document.visibilityState !== 'visible') return
      running = true
      try {
        const keepPolling = await callbackRef.current()
        runs += 1
        if (keepPolling === false || (maxRuns !== undefined && runs >= maxRuns)) {
          active = false
          if (interval !== undefined) window.clearInterval(interval)
        }
      } finally {
        running = false
      }
    }

    interval = window.setInterval(() => void tick(), intervalMs)
    function onVisibilityChange() {
      if (refreshOnVisible && document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      active = false
      if (interval !== undefined) window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, intervalMs, maxRuns, refreshOnVisible])
}
