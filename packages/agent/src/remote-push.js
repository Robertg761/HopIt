// @ts-check
import { createCloudGraphService } from './cloud/d1-graph-service.js'
import { workspaceMode } from './constants.js'
import { emit, findLastEventOf, readEventsWithHistory } from './io.js'
import { remotePushEnabled, remotePushUrl } from './paths.js'

const remotePushEventTypes = [
  'remote-push.started',
  'remote-push.connected',
  'remote-push.resumed',
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
        await connectAndReadRemotePush(options, hubUrl, state, {
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
          closeCode: error?.wsCloseCode ?? null,
          closeReason: error?.wsCloseReason ?? null,
          wasClean: error?.wsWasClean ?? null,
          errorDetail: error?.wsErrorDetail ?? null,
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

async function connectAndReadRemotePush(options, hubUrl, state, streamOptions) {
  const protocol = new URL(hubUrl).protocol
  if (protocol === 'ws:' || protocol === 'wss:') {
    await connectAndReadRemotePushWebSocket(options, hubUrl, state, streamOptions)
    return
  }
  if (protocol === 'http:' || protocol === 'https:') {
    await connectAndReadRemotePushStream(options, hubUrl, state, streamOptions)
    return
  }
  throw new Error(`remote_push_unsupported_url_scheme: ${protocol}`)
}

async function connectAndReadRemotePushStream(options, hubUrl, state, streamOptions) {
  const connectUrl = await remotePushConnectUrl(options, hubUrl, state)
  const response = await fetch(connectUrl, {
    cache: 'no-store',
    signal: streamOptions.signal,
    headers: {
      accept: 'application/x-ndjson, application/json',
      ...remotePushAuthorizationHeaders(options),
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

async function connectAndReadRemotePushWebSocket(options, hubUrl, state, streamOptions) {
  if (typeof WebSocket !== 'function') {
    throw new Error('remote_push_websocket_unavailable')
  }

  const connectUrl = await remotePushConnectUrl(options, hubUrl, state, { includeAuthQuery: true })
  const socket = new WebSocket(connectUrl.toString())
  let settled = false
  let messageChain = Promise.resolve()

  const closeOnAbort = () => {
    socket.close()
  }
  streamOptions.signal?.addEventListener('abort', closeOnAbort, { once: true })

  try {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('remote_push_websocket_error'))
      }
      const onClose = () => {
        cleanup()
        reject(new Error('remote_push_websocket_closed'))
      }
      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
    })

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
      transport: 'websocket',
      safeRefreshOnly: true,
    })

    streamOptions.transport = 'websocket'
    if (streamOptions.runFallbackAfterConnect) {
      await runRemotePushFallbackPoll(options, state, streamOptions)
    }

    await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onMessage = (event) => {
        messageChain = messageChain.then(async () => {
          const text = await textFromWebSocketData(event.data)
          const message = JSON.parse(text)
          if (message?.type !== 'codebase.remote_update') return
          await handleRemotePushEnvelope(options, message, state, streamOptions)
        }).catch(fail)
      }
      const onError = (event) => {
        fail(decorateWebSocketError(new Error('remote_push_websocket_error'), event))
      }
      const onClose = (event) => {
        messageChain.finally(() => {
          fail(decorateWebSocketError(new Error('remote_push_websocket_closed'), event))
        })
      }
      const cleanup = () => {
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('message', onMessage)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
    })
  } finally {
    streamOptions.signal?.removeEventListener('abort', closeOnAbort)
    socket.close()
  }
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

  const outcome = await runRemotePushDecision(options, state, streamOptions, {
    trigger: 'remote-push-fallback',
    eventId: state.lastEventId,
    pushedRevision: state.lastPushedRevision,
    envelope: null,
  })

  // The catch-up poll runs right after a (re)connect while the socket is open.
  // When it applies/skips/fails it emits a terminal event that truthfully
  // becomes the latest state. But when the poll finds nothing to do it emits
  // NOTHING, leaving `remote-push.fallback_polling` as the journal's latest
  // remote-push event — so /status would report `push-fallback-polling` (and
  // the desktop app "Polling") even though the socket is healthily connected.
  // Emit `remote-push.resumed` so the latest event reflects the live socket.
  // `push-fallback-polling` then only lingers as latest when we are genuinely
  // polling without an active socket.
  if (outcome.emitted === 'none' && isConnectionAlive(streamOptions)) {
    await emit(options, 'remote-push.resumed', {
      state: 'push-connected',
      workspace: options.workspace,
      lastEventId: state.lastEventId,
      lastPushedRevision: state.lastPushedRevision,
      trigger: 'remote-push-fallback',
      transport: streamOptions.transport ?? null,
      safeRefreshOnly: true,
    })
  }
}

function isConnectionAlive(streamOptions) {
  // The abort signal fires when the client is closing or the socket dropped.
  // Absent a signal (older callers) treat the just-connected session as alive.
  return streamOptions.signal ? !streamOptions.signal.aborted : true
}

// Returns `{ emitted }` describing which terminal event (if any) the poll
// wrote: 'applied' | 'skipped' | 'failed' | 'none'. The fallback-poll caller
// uses 'none' (an up-to-date poll that emitted nothing) to decide whether it
// must emit `remote-push.resumed` so the journal's latest event stays truthful.
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
        return { emitted: 'skipped' }
      }
      return { emitted: 'none' }
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
    return { emitted: 'applied' }
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
    return { emitted: 'failed' }
  }
}

async function remotePushConnectUrl(options, hubUrl, state, connectOptions = {}) {
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
  if (connectOptions.includeAuthQuery && !url.searchParams.has('access_token') && !url.searchParams.has('token')) {
    const token = remotePushAuthToken(options)
    if (token) url.searchParams.set('access_token', token)
  }
  return url
}

async function readInitialPushState(options) {
  // Read the rotated generation as well as the current file: right after a
  // size-based events rotation the last remote-push cursor events can sit in
  // the rotated <name>.1.ndjson, and reading current-only would needlessly
  // reset lastEventId/lastAppliedRevision.
  const events = await readEventsWithHistory(options.events)
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

function remotePushAuthorizationHeaders(options) {
  const token = remotePushAuthToken(options)
  return token ? { authorization: `Bearer ${token}` } : {}
}

function remotePushAuthToken(options) {
  return options['session-token']
    ?? options.agentSessionToken
    ?? process.env.HOPIT_AGENT_SESSION_TOKEN
    ?? options['d1-api-token']
    ?? process.env.HOPIT_D1_API_TOKEN
    ?? process.env.CLOUDFLARE_API_TOKEN
    ?? null
}

// A WebSocket `close` event carries a numeric `code` and text `reason`; an
// `error` event may carry an underlying `error`/`message`. Attach whatever the
// event exposes to the thrown Error so the disconnected journal entry records
// concrete close diagnostics instead of a bare `remote_push_websocket_error`.
function decorateWebSocketError(error, event) {
  if (event && typeof event === 'object') {
    if (Number.isInteger(event.code)) error.wsCloseCode = event.code
    if (typeof event.reason === 'string' && event.reason.length > 0) error.wsCloseReason = event.reason
    if (typeof event.wasClean === 'boolean') error.wsWasClean = event.wasClean
    const underlying = event.error ?? event.message ?? null
    if (underlying != null) {
      error.wsErrorDetail = underlying instanceof Error ? underlying.message : String(underlying)
    }
  }
  return error
}

async function textFromWebSocketData(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  if (data && typeof data.text === 'function') return await data.text()
  return String(data ?? '')
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function redactUrl(value) {
  try {
    const url = new URL(value)
    if (url.username) url.username = 'redacted'
    if (url.password) url.password = 'redacted'
    for (const name of ['access_token', 'token']) {
      if (url.searchParams.has(name)) url.searchParams.set(name, 'redacted')
    }
    return url.toString()
  } catch {
    return null
  }
}
