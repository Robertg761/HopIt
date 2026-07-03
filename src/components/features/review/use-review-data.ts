'use client'

import * as React from 'react'

import {
  createReviewDecision,
  createReviewThread,
  createReviewThreadComment,
  fetchReviewDecisions,
  fetchReviewThreads,
  resolveReviewThread,
  type CollaborationError,
  type CreateReviewThreadInput,
  type ReviewDecision,
  type ReviewDecisionKind,
  type ReviewThread,
} from '@/lib/collaboration'
import { useToast } from '@/hooks/use-toast'
import { isBackendUnavailable } from './review-shared'
import { humanizeApiError } from '@/lib/client/errors'

export type ReviewData = {
  threads: ReviewThread[]
  threadsLoading: boolean
  threadsUnavailable: boolean
  decisions: ReviewDecision[]
  decisionsLoading: boolean
  decisionsUnavailable: boolean
  creatingThread: boolean
  commentingThreadId: string | null
  resolvingThreadId: string | null
  submittingDecision: boolean
  createThread: (
    input: Omit<CreateReviewThreadInput, 'codebaseId' | 'changeSetId' | 'createdBy'>,
  ) => Promise<boolean>
  addThreadComment: (threadId: string, body: string) => Promise<boolean>
  resolveThread: (threadId: string) => Promise<boolean>
  submitDecision: (decision: ReviewDecisionKind, summary: string) => Promise<boolean>
}

type ThreadsState = { key: string; threads: ReviewThread[]; unavailable: boolean }
type DecisionsState = { key: string; decisions: ReviewDecision[]; unavailable: boolean }

function scopeKeyFor(codebaseId: string, changeSetId: string | null): string {
  return `${codebaseId}::${changeSetId ?? 'all'}`
}

/** Owns review threads + decisions for the active change set (hosted D1 only). */
export function useReviewData(
  codebaseId: string | null,
  changeSetId: string | null,
  actorId: string,
): ReviewData {
  const { toast } = useToast()
  const scopeKey = codebaseId ? scopeKeyFor(codebaseId, changeSetId) : null
  const [threadsState, setThreadsState] = React.useState<ThreadsState | null>(null)
  const [decisionsState, setDecisionsState] = React.useState<DecisionsState | null>(null)
  const [creatingThread, setCreatingThread] = React.useState(false)
  const [commentingThreadId, setCommentingThreadId] = React.useState<string | null>(null)
  const [resolvingThreadId, setResolvingThreadId] = React.useState<string | null>(null)
  const [submittingDecision, setSubmittingDecision] = React.useState(false)

  const reportError = React.useCallback(
    (title: string, error: CollaborationError | undefined) => {
      if (isBackendUnavailable(error)) return
      toast({
        title,
        description: humanizeApiError(error?.message) || 'The request failed.',
        variant: 'destructive',
      })
    },
    [toast],
  )

  React.useEffect(() => {
    if (!codebaseId) return
    let cancelled = false
    const key = scopeKeyFor(codebaseId, changeSetId)
    void fetchReviewThreads(codebaseId, changeSetId).then((result) => {
      if (cancelled) return
      setThreadsState({
        key,
        threads: result.threads,
        unavailable: !result.ok && isBackendUnavailable(result.error),
      })
    })
    return () => {
      cancelled = true
    }
  }, [codebaseId, changeSetId])

  React.useEffect(() => {
    if (!codebaseId) return
    let cancelled = false
    const key = scopeKeyFor(codebaseId, changeSetId)
    void fetchReviewDecisions(codebaseId, changeSetId).then((result) => {
      if (cancelled) return
      setDecisionsState({
        key,
        decisions: result.decisions,
        unavailable: !result.ok && isBackendUnavailable(result.error),
      })
    })
    return () => {
      cancelled = true
    }
  }, [codebaseId, changeSetId])

  const createThread = React.useCallback<ReviewData['createThread']>(
    async (input) => {
      if (!codebaseId || !changeSetId) return false
      setCreatingThread(true)
      try {
        const result = await createReviewThread({
          ...input,
          codebaseId,
          changeSetId,
          createdBy: actorId,
        })
        if (result.ok) {
          setThreadsState({
            key: scopeKeyFor(codebaseId, changeSetId),
            threads: result.threads,
            unavailable: false,
          })
        } else {
          reportError('Review thread failed', result.error)
          if (isBackendUnavailable(result.error)) {
            setThreadsState({ key: scopeKeyFor(codebaseId, changeSetId), threads: [], unavailable: true })
          }
        }
        return result.ok
      } finally {
        setCreatingThread(false)
      }
    },
    [actorId, changeSetId, codebaseId, reportError],
  )

  const addThreadComment = React.useCallback<ReviewData['addThreadComment']>(
    async (threadId, body) => {
      if (!codebaseId) return false
      setCommentingThreadId(threadId)
      try {
        const result = await createReviewThreadComment({
          codebaseId,
          changeSetId,
          threadId,
          body,
          createdBy: actorId,
        })
        if (result.ok) {
          setThreadsState({
            key: scopeKeyFor(codebaseId, changeSetId),
            threads: result.threads,
            unavailable: false,
          })
        } else {
          reportError('Comment failed', result.error)
        }
        return result.ok
      } finally {
        setCommentingThreadId(null)
      }
    },
    [actorId, changeSetId, codebaseId, reportError],
  )

  const resolveThread = React.useCallback<ReviewData['resolveThread']>(
    async (threadId) => {
      if (!codebaseId) return false
      setResolvingThreadId(threadId)
      try {
        const result = await resolveReviewThread({
          codebaseId,
          changeSetId,
          threadId,
          updatedBy: actorId,
        })
        if (result.ok) {
          setThreadsState({
            key: scopeKeyFor(codebaseId, changeSetId),
            threads: result.threads,
            unavailable: false,
          })
        } else {
          reportError('Resolve failed', result.error)
        }
        return result.ok
      } finally {
        setResolvingThreadId(null)
      }
    },
    [actorId, changeSetId, codebaseId, reportError],
  )

  const submitDecision = React.useCallback<ReviewData['submitDecision']>(
    async (decision, summary) => {
      if (!codebaseId || !changeSetId) return false
      setSubmittingDecision(true)
      try {
        const result = await createReviewDecision({
          codebaseId,
          changeSetId,
          decision,
          summary: summary.trim() ? summary.trim() : null,
          createdBy: actorId,
        })
        if (result.ok) {
          setDecisionsState({
            key: scopeKeyFor(codebaseId, changeSetId),
            decisions: result.decisions,
            unavailable: false,
          })
        } else {
          reportError('Decision failed', result.error)
          if (isBackendUnavailable(result.error)) {
            setDecisionsState({ key: scopeKeyFor(codebaseId, changeSetId), decisions: [], unavailable: true })
          }
        }
        return result.ok
      } finally {
        setSubmittingDecision(false)
      }
    },
    [actorId, changeSetId, codebaseId, reportError],
  )

  const threadsReady = scopeKey !== null && threadsState?.key === scopeKey
  const decisionsReady = scopeKey !== null && decisionsState?.key === scopeKey

  return {
    threads: threadsReady && threadsState ? threadsState.threads : [],
    threadsLoading: scopeKey !== null && !threadsReady,
    threadsUnavailable: threadsReady && threadsState ? threadsState.unavailable : false,
    decisions: decisionsReady && decisionsState ? decisionsState.decisions : [],
    decisionsLoading: scopeKey !== null && !decisionsReady,
    decisionsUnavailable: decisionsReady && decisionsState ? decisionsState.unavailable : false,
    creatingThread,
    commentingThreadId,
    resolvingThreadId,
    submittingDecision,
    createThread,
    addThreadComment,
    resolveThread,
    submitDecision,
  }
}
