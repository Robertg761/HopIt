export type FileApiFailure = { ok: false; code: string | null; message: string }

export type FileContentResult = { ok: true; content: string; revision: number | null } | FileApiFailure

export type FileSaveResult = { ok: true; revision: number | null } | FileApiFailure

type RawEnvelope = {
  ok?: boolean
  error?: { code?: string; message?: string }
  file?: { content?: unknown; revision?: unknown }
  result?: { revision?: unknown }
}

function failure(payload: RawEnvelope | null, fallback: string): FileApiFailure {
  return {
    ok: false,
    code: typeof payload?.error?.code === 'string' ? payload.error.code : null,
    message: typeof payload?.error?.message === 'string' ? payload.error.message : fallback,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchCodebaseFile(codebaseId: string, path: string): Promise<FileContentResult> {
  const fallback = 'Could not load the file.'
  try {
    const query = `codebaseId=${encodeURIComponent(codebaseId)}&path=${encodeURIComponent(path)}`
    const response = await fetch(`/api/codebase-files?${query}`, { cache: 'no-store' })
    const payload = (await response.json().catch(() => null)) as RawEnvelope | null
    if (!payload || payload.ok !== true) return failure(payload, fallback)
    return {
      ok: true,
      content: typeof payload.file?.content === 'string' ? payload.file.content : '',
      revision: numberOrNull(payload.file?.revision),
    }
  } catch (error) {
    return { ok: false, code: null, message: error instanceof Error ? error.message : fallback }
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
    const response = await fetch('/api/codebase-files', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => null)) as RawEnvelope | null
    if (!payload || payload.ok !== true) return failure(payload, fallback)
    return { ok: true, revision: numberOrNull(payload.result?.revision) }
  } catch (error) {
    return { ok: false, code: null, message: error instanceof Error ? error.message : fallback }
  }
}
