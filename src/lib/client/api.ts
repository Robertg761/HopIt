import { humanizeApiError } from './errors'

export type ApiErrorDetails = {
  code: string | null
  message: string
}

export class ApiFetchError extends Error {
  code: string | null
  status: number | null
  payload: unknown

  constructor(error: ApiErrorDetails, options: { status?: number | null; payload?: unknown } = {}) {
    super(error.message)
    this.name = 'ApiFetchError'
    this.code = error.code
    this.status = options.status ?? null
    this.payload = options.payload
  }
}

type ApiFetchInit = RequestInit & {
  allowErrorEnvelope?: boolean
}

export async function apiFetch<T>(input: RequestInfo | URL, init: ApiFetchInit = {}): Promise<T> {
  const { allowErrorEnvelope = false, headers: initHeaders, ...requestInit } = init
  const headers = jsonHeaders(initHeaders, requestInit.body)

  let response: Response
  try {
    response = await fetch(input, { cache: 'no-store', ...requestInit, headers })
  } catch (error) {
    throw new ApiFetchError({
      code: null,
      message: humanizeApiError(error instanceof Error ? error.message : 'The request failed.'),
    })
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const envelope = apiEnvelope(payload)

  if (envelope?.ok === false && !allowErrorEnvelope) {
    throw new ApiFetchError(apiError(envelope.error, response.statusText || 'The request failed.'), {
      status: response.status,
      payload,
    })
  }

  if (!response.ok && !allowErrorEnvelope) {
    throw new ApiFetchError(apiError(envelope?.error, response.statusText || `Request returned ${response.status}.`), {
      status: response.status,
      payload,
    })
  }

  if (payload === null) {
    throw new ApiFetchError({
      code: response.ok ? null : `http_${response.status}`,
      message: humanizeApiError(response.statusText || 'The server returned an unexpected response.'),
    }, {
      status: response.status,
      payload,
    })
  }

  return payload as T
}

export function apiErrorFromUnknown(error: unknown, fallback = 'The request failed.'): ApiErrorDetails {
  if (error instanceof ApiFetchError) {
    return {
      code: error.code,
      message: error.message || humanizeApiError(fallback),
    }
  }

  return {
    code: null,
    message: humanizeApiError(error instanceof Error ? error.message : fallback),
  }
}

export function apiPayloadFromError<T>(error: unknown): T | null {
  return error instanceof ApiFetchError && error.payload !== null && typeof error.payload === 'object'
    ? (error.payload as T)
    : null
}

function jsonHeaders(initHeaders: HeadersInit | undefined, body: BodyInit | null | undefined): Headers {
  const headers = new Headers(initHeaders)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (body !== undefined && body !== null && !headers.has('Content-Type') && shouldSendJson(body)) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

function shouldSendJson(body: BodyInit): boolean {
  return typeof body === 'string'
}

function apiEnvelope(payload: unknown): { ok?: boolean; error?: unknown } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as { ok?: boolean; error?: unknown }
}

function apiError(error: unknown, fallback: string): ApiErrorDetails {
  const record = error && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>) : null
  const message = typeof record?.message === 'string' && record.message.trim() ? record.message : fallback
  return {
    code: typeof record?.code === 'string' ? record.code : null,
    message: humanizeApiError(message),
  }
}
