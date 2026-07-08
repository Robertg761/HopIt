// @ts-check
import { createCloudGraphService } from './cloud/d1-graph-service.js'
import { workspaceMode } from './constants.js'
import { emit, findLastEventOf, readNdjson } from './io.js'
import { remotePushEnabled, remotePushUrl } from './paths.js'

const remotePushEventTypes = [
  'remote-push.started',
  'remote-push.connected',
  'remote-push.disconnected',
  'remote-push.fallback_polling',
  'remote-push.applied',
  'remote-push.skipped',
  'remote-push.failed',
]

/**
 * @param {Record<string, any>} options
 * @param {{
 *   localSyncIdle?: () => boolean,
 *   remoteRefreshDecision: (options: Record<string, any>, context: { trigger: string, localSyncIdle: () => boolean }) => Promise<Record<string, any>>,
 *   refreshWorkspace: (options: Record<string, any>) => Promise<void>,
 *   minBackoffMs?: number,
 *   maxBackoffMs?: number,
 * }} clientOptions
 */
export async function createRemotePushClient(options, clientOptions) {
  if (!remotePushEnabled(options)) return null

  const hubUrl = remotePushUrl(options)
  const localSyncIdle = clientOptions.localSyncIdle ?? (() => true)
  const state = await readInitialPushState(options)
  let closed = false
  let controller = null

  await emit(options, 'remote-push.started', {
    state: 'push-disconnected',
    workspace: options.workspace,
    hubUrl: hubUrl ? redactUrl(hubUrl) : null,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    safeRefreshOnly: true,
  })

  if (!hubUrl) {
    await emit(options, 'remote-push.failed', {
      state: 'push-disconnected',
      workspace: options.workspace,
      reason: 'remote_push_url_missing',
      safeRefreshOnly: true,
    })
    return {
      close() {
        closed = true
      },
    }
  }

  const loop = async () => {
    let attempt = 0
    let shouldRunFallbackAfterConnect = false
    while (!closed) {
      try {
        controller = new AbortController()
        await connectAndReadRemotePushStream(options, hubUrl, state, {
          signal: controller.signal,
          runFallbackAfterConnect: shouldRunFallbackAfterConnect,
          localSyncIdle,
          remoteRefreshDecision: clientOptions.remoteRefreshDecision,
          refreshWorkspace: clientOptions.refreshWorkspace,
        })
        attempt = 0
        shouldRunFallbackAfterConnect = true
      } catch (error) {
        if (closed) return
        await emit(options, 'remote-push.disconnected', {
          state: 'push-disconnected',
          workspace: options.workspace,
          hubUrl: redactUrl(hubUrl),
          reason: error instanceof Error ? error.message : 'remote_push_disconnected',
          lastEventId: state.lastEventId,
          lastPushedRevision: state.lastPushedRevision,
          safeRefreshOnly: true,
        })
        attempt += 1
        shouldRunFallbackAfterConnect = true
      } finally {
        controller = null
      }

      if (!closed) {
        await delay(backoffMs(attempt, clientOptions))
      }
    }
  }

  loop().catch((error) => {
    if (!closed) console.error(error)
  })

  return {
    close() {
      closed = true
      controller?.abort()
    },
  }
}

async function connectAndReadRemotePushStream(options, hubUrl, state, streamOptions) {
  const connectUrl = await remotePushConnectUrl(options, hubUrl, state)
  const response = await fetch(connectUrl, {
    cache: 'no-store',
    signal: streamOptions.signal,
    headers: {
      accept: 'application/x-ndjson, application/json',
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`remote_push_connect_failed: ${response.status}`)
  }

  await emit(options, 'remote-push.connected', {
    state: 'push-connected',
    workspace: options.workspace,
    hubUrl: redactUrl(hubUrl),
    codebaseId: state.codebaseId,
    selectedStateId: state.selectedStateId,
    sessionId: options['session-id'] ?? null,
    deviceName: options['device-name'] ?? null,
    lastEventId: state.lastEventId,
    lastPushedRevision: state.lastPushedRevision,
    safeRefreshOnly: true,
  })

  if (streamOptions.runFallbackAfterConnect) {
    await runRemotePushFallbackPoll(options, state, streamOptions)
  }

  await readNdjsonStream(response.body, async (message) => {
    if (message?.type !== 'codebase.remote_update') return
    await handleRemotePushEnvelope(options, message, state, streamOptions)
  })

  throw new Error('remote_push_stream_closed')
}

async function handleRemotePushEnvelope(options, envelope, state, streamOptions) {
  const normalized = normalizeRemotePushEnvelope(envelope)
  if (!normalized) {
    await emit(options, 'remote-push.failed', {
      state: 'push-disconnected',
      workspace: options.workspace,
      reason: 'remote_push_invalid_envelope',
      safeRefreshOnly: true,
    })
    return
  }

  if (state.seenEventIds.has(normalized.eventId)) return
  if (state.codebaseId && normalized.codebaseId !== state.codebaseId) return
  if (state.selectedStateId && normalized.selectedStateId !== state.selectedStateId) return
  if (Number.isInteger(state.lastAppliedRevision) && normalized.revision <= state.lastAppliedRevision) {
    state.seenEventIds.add(normalized.eventId)
    state.lastEventId = normalized.eventId
    return
  }

  state.seenEventIds.add(normalized.eventId)
  state.lastEventId = normalized.eventId
  state.lastPushedRevision = Math.max(state.lastPushedRevision ?? 0, normalized.revision)

  await runRemotePushDecision(options, state, streamOptions, {
    trigger: 'remote-push',
    eventId: normalized.eventId,
    pushedRevision: normalized.revision,
    envelope: normalized,
  })
}

async function runRemotePushFallbackPoll(options, state, streamOptions) {
  await emit(options, 'remote-push.fallback_polling', {
    state: 'push-fallback-polling',
    workspace: options.workspace,
    lastEventId: state.lastEventId,
    lastPushedRevision: state.lastPushedRevision,
    safeRefreshOnly: true,
  })

  await runRemotePushDecision(options, state, streamOptions, {
    trigger: 'remote-push-fallback',
    eventId: state.lastEventId,
    pushedRevision: state.lastPushedRevision,
    envelope: null,
  })
}

async function runRemotePushDecision(options, state, streamOptions, detail) {
  try {
    const decision = await streamOptions.remoteRefreshDecision(options, {
      trigger: detail.trigger,
      localSyncIdle: streamOptions.localSyncIdle,
    })

    if (decision.state === 'skip') {
      if (decision.emit) {
        await emit(options, 'remote-push.skipped', {
          ...(decision.detail ?? {}),
          state: 'push-skipped',
          trigger: detail.trigger,
          eventId: detail.eventId ?? null,
          pushedRevision: detail.pushedRevision ?? null,
          envelope: detail.envelope,
          safeRefreshOnly: true,
        })
      }
      return
    }

    await streamOptions.refreshWorkspace(options)
    const appliedRevision = decision.toRevision
    if (Number.isInteger(appliedRevision)) {
      state.lastAppliedRevision = Math.max(state.lastAppliedRevision ?? 0, appliedRevision)
    }
    await emit(options, 'remote-push.applied', {
      state: 'push-applied',
      trigger: detail.trigger,
      eventId: detail.eventId ?? null,
      pushedRevision: detail.pushedRevision ?? null,
      workspace: options.workspace,
      fromRevision: decision.fromRevision,
      toRevision: decision.toRevision,
      lastPushedRevision: state.lastPushedRevision,
      safeRefreshOnly: true,
    })
  } catch (error) {
    await emit(options, 'remote-push.failed', {
      state: 'push-disconnected',
      trigger: detail.trigger,
      eventId: detail.eventId ?? null,
      pushedRevision: detail.pushedRevision ?? null,
      workspace: options.workspace,
      reason: error instanceof Error ? error.message : 'remote_push_failed',
      safeRefreshOnly: true,
    })
  }
}

async function remotePushConnectUrl(options, hubUrl, state) {
  const cloudService = createCloudGraphService(options)
  const head = await cloudService.readGraphHead()
  state.codebaseId = head?.codebase?.id ?? options['codebase-id'] ?? state.codebaseId ?? null
  state.selectedStateId = head?.selectedState?.id ?? state.selectedStateId ?? null
  state.selectedStateRevision = head?.selectedState?.revision ?? state.selectedStateRevision ?? null

  const url = new URL(hubUrl)
  if (state.codebaseId) url.searchParams.set('codebaseId', state.codebaseId)
  if (state.selectedStateId) url.searchParams.set('selectedStateId', state.selectedStateId)
  if (options['session-id']) url.searchParams.set('sessionId', options['session-id'])
  if (options['device-name']) url.searchParams.set('deviceName', options['device-name'])
  if (state.lastEventId) url.searchParams.set('lastEventId', state.lastEventId)
  if (Number.isInteger(state.lastPushedRevision)) {
    url.searchParams.set('lastRevision', String(state.lastPushedRevision))
  }
  return url
}

async function readInitialPushState(options) {
  const events = await readNdjson(options.events)
  const lastPushEvent = findLastEventOf(events, remotePushEventTypes)
  const lastApplied = findLastEventOf(events, ['remote-push.applied'])
  return {
    seenEventIds: new Set(),
    codebaseId: null,
    selectedStateId: null,
    selectedStateRevision: null,
    lastEventId: lastPushEvent?.detail?.eventId ?? null,
    lastPushedRevision: integerOrNull(lastPushEvent?.detail?.pushedRevision ?? lastPushEvent?.detail?.lastPushedRevision),
    lastAppliedRevision: integerOrNull(lastApplied?.detail?.toRevision),
  }
}

async function readNdjsonStream(body, onMessage) {
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true })
    let newlineIndex = buffered.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).trim()
      buffered = buffered.slice(newlineIndex + 1)
      if (line) await onMessage(JSON.parse(line))
      newlineIndex = buffered.indexOf('\n')
    }
  }
  buffered += decoder.decode()
  const tail = buffered.trim()
  if (tail) await onMessage(JSON.parse(tail))
}

function normalizeRemotePushEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null
  if (envelope.type !== 'codebase.remote_update') return null
  if (typeof envelope.codebaseId !== 'string' || envelope.codebaseId.length === 0) return null
  if (typeof envelope.selectedStateId !== 'string' || envelope.selectedStateId.length === 0) return null
  if (!Number.isInteger(envelope.revision)) return null
  if (typeof envelope.eventId !== 'string' || envelope.eventId.length === 0) return null
  if (!Array.isArray(envelope.changedPaths)) return null
  if (Object.hasOwn(envelope, 'content') || Object.hasOwn(envelope, 'files') || Object.hasOwn(envelope, 'bytes')) return null

  return {
    type: envelope.type,
    codebaseId: envelope.codebaseId,
    selectedStateId: envelope.selectedStateId,
    revision: envelope.revision,
    eventId: envelope.eventId,
    changedPaths: envelope.changedPaths.filter((entry) => typeof entry === 'string'),
    scopeCounts: normalizeScopeCounts(envelope.scopeCounts),
  }
}

function normalizeScopeCounts(scopeCounts) {
  return {
    shared: Number.isInteger(scopeCounts?.shared) ? scopeCounts.shared : 0,
    private: Number.isInteger(scopeCounts?.private) ? scopeCounts.private : 0,
  }
}

function backoffMs(attempt, options) {
  const minBackoffMs = options.minBackoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 5000
  return Math.min(maxBackoffMs, minBackoffMs * (2 ** Math.max(0, attempt - 1)))
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function redactUrl(value) {
  try {
    const url = new URL(value)
    if (url.username) url.username = 'redacted'
    if (url.password) url.password = 'redacted'
    return url.toString()
  } catch {
    return null
  }
}
