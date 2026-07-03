import { humanizeApiError } from '@/lib/client/errors'
import { apiErrorFromUnknown, apiFetch } from '@/lib/client/api'

export type ApiError = { code: string | null; message: string }

export type ApiResult = { ok: true } | { ok: false; error: ApiError }

async function requestCodebases(
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>,
  fallback: string,
): Promise<ApiResult> {
  try {
    await apiFetch('/api/codebases', {
      method,
      body: JSON.stringify(body),
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: apiErrorFromUnknown(error, fallback) }
  }
}

export function createCodebase(input: { name: string; description?: string }): Promise<ApiResult> {
  return requestCodebases('POST', input, 'Could not create the codebase.')
}

export function renameCodebase(input: { codebaseId: string; name: string }): Promise<ApiResult> {
  return requestCodebases('PATCH', input, 'Could not rename the codebase.')
}

export function deleteCodebase(input: { codebaseId: string }): Promise<ApiResult> {
  return requestCodebases('DELETE', input, 'Could not delete the codebase.')
}

/** Turn machine-ish error strings into a readable sentence. */
export function humanizeMessage(message: string): string {
  const friendly = humanizeApiError(message)
  if (friendly !== message.trim()) return friendly
  const cleaned = message.trim().replace(/_+/g, ' ')
  if (!cleaned) return 'Something went wrong.'
  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}
