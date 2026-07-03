import { apiErrorFromUnknown, apiFetch } from '@/lib/client/api'

export type FileApiFailure = { ok: false; code: string | null; message: string }

export type FileContentResult = { ok: true; content: string; revision: number | null } | FileApiFailure

export type FileSaveResult = { ok: true; revision: number | null } | FileApiFailure

type FileEnvelope = {
  ok?: boolean
  error?: { code?: string; message?: string }
  file?: { content?: unknown; revision?: unknown }
  result?: { revision?: unknown }
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
    return {
      ok: true,
      content: typeof payload.file?.content === 'string' ? payload.file.content : '',
      revision: numberOrNull(payload.file?.revision),
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
}): Promise<FileSaveResult> {
  const fallback = 'Could not save the file.'
  const body: Record<string, unknown> = {
    codebaseId: input.codebaseId,
    path: input.path,
    content: input.content,
  }
  if (typeof input.baseRevision === 'number') body.baseRevision = input.baseRevision
  try {
    const payload = await apiFetch<FileEnvelope>('/api/codebase-files', {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    return { ok: true, revision: numberOrNull(payload.result?.revision) }
  } catch (error) {
    return failure(error, fallback)
  }
}
