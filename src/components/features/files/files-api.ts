import { apiErrorFromUnknown, apiFetch } from '@/lib/client/api'

export type FileApiFailure = { ok: false; code: string | null; message: string }

export type FileContentResult = {
  ok: true
  content: string
  revision: number | null
  selectedStateId: string
} | FileApiFailure

export type FileSaveResult = {
  ok: true
  revision: number | null
  selectedStateId: string
} | FileApiFailure

type FileEnvelope = {
  ok?: boolean
  error?: { code?: string; message?: string }
  file?: { content?: unknown; revision?: unknown; selectedStateId?: unknown }
  result?: { revision?: unknown; selectedStateId?: unknown }
}

function failure(error: unknown, fallback: string): FileApiFailure {
  const details = apiErrorFromUnknown(error, fallback)
  return {
    ok: false,
    code: details.code,
    message: details.message,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchCodebaseFile(codebaseId: string, path: string): Promise<FileContentResult> {
  const fallback = 'Could not load the file.'
  try {
    const query = `codebaseId=${encodeURIComponent(codebaseId)}&path=${encodeURIComponent(path)}`
    const payload = await apiFetch<FileEnvelope>(`/api/codebase-files?${query}`)
    if (typeof payload.file?.selectedStateId !== 'string' || payload.file.selectedStateId.length === 0) {
      throw new Error('The file response did not identify its active change set.')
    }
    return {
      ok: true,
      content: typeof payload.file?.content === 'string' ? payload.file.content : '',
      revision: numberOrNull(payload.file?.revision),
      selectedStateId: payload.file.selectedStateId,
    }
  } catch (error) {
    return failure(error, fallback)
  }
}

export async function saveCodebaseFile(input: {
  codebaseId: string
  path: string
  content: string
  baseRevision?: number | null
  selectedStateId: string
}): Promise<FileSaveResult> {
  const fallback = 'Could not save the file.'
  const body: Record<string, unknown> = {
    codebaseId: input.codebaseId,
    path: input.path,
    content: input.content,
    selectedStateId: input.selectedStateId,
  }
  if (typeof input.baseRevision === 'number') body.baseRevision = input.baseRevision
  try {
    const payload = await apiFetch<FileEnvelope>('/api/codebase-files', {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    const selectedStateId = payload.result?.selectedStateId
    if (typeof selectedStateId !== 'string' || selectedStateId.length === 0) {
      throw new Error('The save response did not identify its active change set.')
    }
    return {
      ok: true,
      revision: numberOrNull(payload.result?.revision),
      selectedStateId,
    }
  } catch (error) {
    return failure(error, fallback)
  }
}
