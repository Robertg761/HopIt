'use client'

import * as React from 'react'

import {
  fetchCompareRevisions,
  fetchDirectoryCompare,
  fetchFileDiff,
} from '@/lib/client/compare/api'
import { apiErrorFromUnknown } from '@/lib/client/api'
import { initialRevisionPair, revisionOptions } from '@/lib/client/compare/mappers'
import type {
  CompareEntry,
  CompareError,
  CompareRetention,
  CompareSummary,
} from '@/lib/client/compare/types'

/**
 * Owns the compare surface's data and its client-side per-view cache — the cache
 * the WS7c design doc deferred to this consumer. Two caches, both keyed so that
 * switching the selected file never re-fetches the directory compare:
 *
 *   directoryCache  keyed by `${from}:${to}`
 *   fileCache       keyed by `${from}:${to}:${path}`
 *
 * Re-selecting a file, or flipping back to a revision pair already viewed, is
 * served from cache with no network round-trip.
 */

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: CompareError }

export type DirectoryData = {
  leftRevision: number
  rightRevision: number
  retention: CompareRetention | null
  summary: CompareSummary | null
  entries: CompareEntry[]
}

export type FileDiffData = {
  path: string
  entry: CompareEntry
}

export type RevisionsData = {
  revisions: number[]
  retention: CompareRetention | null
  options: number[]
}

export type CompareData = {
  revisions: LoadState<RevisionsData> | null
  from: number | null
  to: number | null
  setFrom: (value: number) => void
  setTo: (value: number) => void
  swap: () => void
  directory: LoadState<DirectoryData> | null
  fileDiff: (path: string) => LoadState<FileDiffData> | undefined
  loadFileDiff: (path: string) => void
  reload: () => void
}

function dirKey(from: number, to: number) {
  return `${from}:${to}`
}

function fileKey(from: number, to: number, path: string) {
  return `${from}:${to}:${path}`
}

export type InitialComparePair = {
  from: number | null
  to: number | null
}

export function useCompareData(
  codebaseId: string | null,
  initialPair?: InitialComparePair,
): CompareData {
  const initialFrom = initialPair?.from ?? null
  const initialTo = initialPair?.to ?? null
  const [revisions, setRevisions] = React.useState<LoadState<RevisionsData> | null>(null)
  const [from, setFromState] = React.useState<number | null>(null)
  const [to, setToState] = React.useState<number | null>(null)
  const [directoryCache, setDirectoryCache] = React.useState<Record<string, LoadState<DirectoryData>>>({})
  const [fileCache, setFileCache] = React.useState<Record<string, LoadState<FileDiffData>>>({})
  const [reloadToken, setReloadToken] = React.useState(0)

  // Keys whose file diff has already been requested. A ref so re-selecting a
  // cached file is a no-op with no network round-trip (the cache guarantee).
  const startedFileKeys = React.useRef<Set<string>>(new Set())

  // Reset everything when the codebase changes or a manual reload is requested.
  React.useEffect(() => {
    setRevisions(null)
    setFromState(null)
    setToState(null)
    setDirectoryCache({})
    setFileCache({})
    startedFileKeys.current = new Set()
  }, [codebaseId, reloadToken])

  // Load the enumerable revisions and pick a sensible default pair.
  React.useEffect(() => {
    if (!codebaseId) return
    let cancelled = false
    setRevisions({ status: 'loading' })
    void fetchCompareRevisions(codebaseId)
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setRevisions({ status: 'error', error: response.error ?? unknownError() })
          return
        }
        const options = revisionOptions(response.revisions, response.retention)
        setRevisions({
          status: 'ready',
          data: { revisions: response.revisions ?? [], retention: response.retention ?? null, options },
        })
        const pair = initialRevisionPair(options, { from: initialFrom, to: initialTo })
        if (pair) {
          setFromState((current) => (current === null ? pair.from : current))
          setToState((current) => (current === null ? pair.to : current))
        }
      })
      .catch((error) => {
        if (cancelled) return
        setRevisions({ status: 'error', error: apiErrorFromUnknown(error) as CompareError })
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId, reloadToken, initialFrom, initialTo])

  // Load the directory compare for the current pair, once per pair.
  React.useEffect(() => {
    if (!codebaseId || from === null || to === null) return
    const key = dirKey(from, to)
    if (directoryCache[key]) return
    let cancelled = false
    setDirectoryCache((cache) => ({ ...cache, [key]: { status: 'loading' } }))
    void fetchDirectoryCompare(codebaseId, from, to)
      .then((response) => {
        if (cancelled) return
        setDirectoryCache((cache) => ({
          ...cache,
          [key]: response.ok
            ? {
                status: 'ready',
                data: {
                  leftRevision: response.leftRevision ?? from,
                  rightRevision: response.rightRevision ?? to,
                  retention: response.retention ?? null,
                  summary: response.summary ?? null,
                  entries: response.entries ?? [],
                },
              }
            : { status: 'error', error: response.error ?? unknownError() },
        }))
      })
      .catch((error) => {
        if (cancelled) return
        setDirectoryCache((cache) => ({
          ...cache,
          [key]: { status: 'error', error: apiErrorFromUnknown(error) as CompareError },
        }))
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId, from, to, directoryCache])

  const loadFileDiff = React.useCallback(
    (path: string) => {
      if (!codebaseId || from === null || to === null) return
      const key = fileKey(from, to, path)
      // Already fetched (or in flight) for this pair+path — serve from cache.
      if (startedFileKeys.current.has(key)) return
      startedFileKeys.current.add(key)
      setFileCache((cache) => ({ ...cache, [key]: { status: 'loading' } }))
      void fetchFileDiff(codebaseId, from, to, path)
        .then((response) => {
          setFileCache((cache) => ({
            ...cache,
            [key]:
              response.ok && response.entry
                ? { status: 'ready', data: { path, entry: response.entry } }
                : { status: 'error', error: response.error ?? unknownError() },
          }))
        })
        .catch((error) => {
          setFileCache((cache) => ({
            ...cache,
            [key]: { status: 'error', error: apiErrorFromUnknown(error) as CompareError },
          }))
        })
    },
    [codebaseId, from, to],
  )

  const fileDiff = React.useCallback(
    (path: string): LoadState<FileDiffData> | undefined => {
      if (from === null || to === null) return undefined
      return fileCache[fileKey(from, to, path)]
    },
    [fileCache, from, to],
  )

  const setFrom = React.useCallback((value: number) => setFromState(value), [])
  const setTo = React.useCallback((value: number) => setToState(value), [])
  const swap = React.useCallback(() => {
    setFromState(to)
    setToState(from)
  }, [from, to])
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  const directory = from !== null && to !== null ? directoryCache[dirKey(from, to)] ?? null : null

  return {
    revisions,
    from,
    to,
    setFrom,
    setTo,
    swap,
    directory,
    fileDiff,
    loadFileDiff,
    reload,
  }
}

function unknownError(): CompareError {
  return { code: 'compare_failed', message: 'The compare request failed.' }
}
