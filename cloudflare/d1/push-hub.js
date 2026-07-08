const lastEnvelopeKey = 'last-envelope'
const lastCursorKey = 'last-cursor'

export class CodebasePushHub {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/notify')) {
      const body = await request.json().catch(() => null)
      return await this.notify(body)
    }

    if (isWebSocketUpgrade(request)) {
      if (typeof WebSocketPair !== 'function') {
        return json({ success: false, error: 'websocket_pair_unavailable' }, 500)
      }
      const pair = new WebSocketPair()
      await this.connectWebSocket(request, pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    return json({ success: false, error: 'not_found' }, 404)
  }

  async notify(payload) {
    const envelope = normalizeRemoteUpdateEnvelope(payload)
    if (!envelope) {
      return json({ success: false, error: 'invalid_remote_update_envelope' }, 400)
    }

    await this.storeEnvelope(envelope)
    await this.broadcast(envelope)
    return json({ success: true, eventId: envelope.eventId, revision: envelope.revision })
  }

  async connectWebSocket(request, webSocket) {
    const url = new URL(request.url)
    const metadata = {
      codebaseId: textOrNull(url.searchParams.get('codebaseId')),
      selectedStateId: textOrNull(url.searchParams.get('selectedStateId')),
      sessionId: textOrNull(url.searchParams.get('sessionId')),
      deviceName: textOrNull(url.searchParams.get('deviceName')),
      lastEventId: textOrNull(url.searchParams.get('lastEventId')),
      lastRevision: integerOrNull(url.searchParams.get('lastRevision')),
      connectedAt: new Date().toISOString(),
    }

    webSocket.serializeAttachment?.(metadata)
    this.state.acceptWebSocket(webSocket, socketTags(metadata))

    const lastEnvelope = normalizeRemoteUpdateEnvelope(await this.state.storage.get(lastEnvelopeKey))
    if (lastEnvelope && shouldSendCursorCatchup(lastEnvelope, metadata)) {
      safeSend(webSocket, lastEnvelope)
    }
  }

  async webSocketMessage(webSocket, message) {
    if (message === 'ping') safeSend(webSocket, { type: 'hub.pong' })
  }

  async webSocketClose(webSocket) {
    webSocket.close?.()
  }

  async webSocketError(webSocket) {
    webSocket.close?.()
  }

  async storeEnvelope(envelope) {
    await this.state.storage.put(lastEnvelopeKey, envelope)
    await this.state.storage.put(lastCursorKey, {
      eventId: envelope.eventId,
      revision: envelope.revision,
      updatedAt: new Date().toISOString(),
    })
  }

  async broadcast(envelope) {
    const sockets = this.state.getWebSockets?.() ?? []
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment?.() ?? null
      if (attachment?.codebaseId && attachment.codebaseId !== envelope.codebaseId) continue
      safeSend(socket, envelope)
    }
  }
}

export function normalizeRemoteUpdateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null
  if (envelope.type !== 'codebase.remote_update') return null
  if (typeof envelope.codebaseId !== 'string' || envelope.codebaseId.length === 0) return null
  if (typeof envelope.selectedStateId !== 'string' || envelope.selectedStateId.length === 0) return null
  if (!Number.isInteger(envelope.revision)) return null
  if (typeof envelope.eventId !== 'string' || envelope.eventId.length === 0) return null
  if (!Array.isArray(envelope.changedPaths)) return null
  if (Object.hasOwn(envelope, 'content') || Object.hasOwn(envelope, 'files') || Object.hasOwn(envelope, 'bytes')) {
    return null
  }

  return {
    type: 'codebase.remote_update',
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

function shouldSendCursorCatchup(envelope, metadata) {
  if (!metadata.lastEventId && !Number.isInteger(metadata.lastRevision)) return true
  if (metadata.lastEventId && metadata.lastEventId === envelope.eventId) return false
  if (Number.isInteger(metadata.lastRevision) && metadata.lastRevision >= envelope.revision) return false
  return true
}

function safeSend(webSocket, payload) {
  try {
    webSocket.send(JSON.stringify(payload))
  } catch {
    webSocket.close?.()
  }
}

function socketTags(metadata) {
  return [
    metadata.codebaseId ? `codebase:${metadata.codebaseId}` : null,
    metadata.sessionId ? `session:${metadata.sessionId}` : null,
    metadata.deviceName ? `device:${metadata.deviceName}` : null,
  ].filter(Boolean)
}

function isWebSocketUpgrade(request) {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function integerOrNull(value) {
  if (Number.isInteger(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
