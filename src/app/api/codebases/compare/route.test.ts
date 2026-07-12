import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route is a thin wrapper over the WS7c `compareRevisions` engine. These
// tests mock that backend service (as well as auth + config), so they exercise
// the route's request/response mapping, not the diff engine itself.

const compareRevisions = vi.fn()
const listFileVersions = vi.fn()
const cloudActorFromRequest = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')
const missingCloudBackendConfig = vi.fn(() => [] as string[])

vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ compareRevisions, listFileVersions }),
}))
vi.mock('@/lib/request-cloud-actor', () => ({
  cloudActorFromRequest: (...args: unknown[]) => cloudActorFromRequest(...args),
}))
vi.mock('@/lib/cloud-backend', () => ({
  configuredCloudBackend: () => configuredCloudBackend(),
  missingCloudBackendConfig: () => missingCloudBackendConfig(),
}))

import { GET } from './route'

function get(query: string) {
  return GET(new Request(`https://app.test/api/codebases/compare?${query}`))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  cloudActorFromRequest.mockResolvedValue({ userId: 'user_1', sessionId: 'sess_1' })
  configuredCloudBackend.mockReturnValue('d1')
  missingCloudBackendConfig.mockReturnValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/codebases/compare', () => {
  it('requires a codebaseId', async () => {
    const response = await get('')
    expect(response.status).toBe(400)
    const payload = await body(response)
    expect(payload.ok).toBe(false)
    expect((payload.error as { code: string }).code).toBe('codebase_required')
  })

  it('reports the backend as unavailable when config is missing', async () => {
    missingCloudBackendConfig.mockReturnValue(['HOPIT_D1_DATABASE_ID'])
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(503)
    expect((await body(response)).error).toMatchObject({ code: 'cloud_backend_unavailable' })
  })

  it('returns browser_auth_required when there is no authenticated user', async () => {
    cloudActorFromRequest.mockResolvedValue(null)
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(401)
    expect((await body(response)).error).toMatchObject({ code: 'browser_auth_required' })
  })

  it('enumerates distinct revisions after authorizing the read', async () => {
    compareRevisions.mockResolvedValue({ ok: false, error: { code: 'revision_expired', message: 'x' } })
    listFileVersions.mockResolvedValue([
      { graphRevision: 2, path: 'a' },
      { graph_revision: 1, path: 'b' },
      { graphRevision: 2, path: 'c' },
      { graphRevision: 4, path: 'd' },
    ])
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload.mode).toBe('revisions')
    expect(payload.revisions).toEqual([1, 2, 4])
    expect(payload.retention).toEqual({ min: 1, max: 4, retainedVersions: 4 })
    // Authorization happens via a compareRevisions probe before listing.
    expect(compareRevisions).toHaveBeenCalledWith(0, 0, expect.objectContaining({ codebaseId: 'repo' }))
  })

  it('reports null retention when no file versions exist', async () => {
    compareRevisions.mockResolvedValue({ ok: false, error: { code: 'revision_expired', message: 'x' } })
    listFileVersions.mockResolvedValue([])
    const payload = await body(await get('codebaseId=repo'))
    expect(payload.revisions).toEqual([])
    expect(payload.retention).toBeNull()
  })

  it('returns a metadata-only directory compare and never requests blob bodies', async () => {
    compareRevisions.mockResolvedValue({
      ok: true,
      leftRevision: 1,
      rightRevision: 3,
      retention: { min: 1, max: 3, retainedVersions: 5 },
      summary: { added: 1, modified: 1, deleted: 0, unchanged: 2, missingBlob: 0, integrityFailures: 0, requiresLocalKey: 0, binaryChanged: 0 },
      entries: [{ path: 'README.md', state: 'modified', kind: 'file', scope: 'shared', privacyZone: 'shared', left: {}, right: {} }],
    })
    const payload = await body(await get('codebaseId=repo&from=1&to=3'))
    expect(payload.mode).toBe('directory')
    expect(payload.leftRevision).toBe(1)
    expect(payload.rightRevision).toBe(3)
    expect((payload.entries as unknown[]).length).toBe(1)
    // Directory mode passes no path, so the engine fetches zero blob bodies.
    expect(compareRevisions).toHaveBeenCalledWith(1, 3, expect.not.objectContaining({ path: expect.anything() }))
  })

  it('passes the path through for a single-file diff and returns its entry', async () => {
    compareRevisions.mockResolvedValue({
      ok: true,
      leftRevision: 1,
      rightRevision: 3,
      entries: [{ path: 'README.md', state: 'modified', body: { state: 'text_diff', diff: {} } }],
      bodyFetches: 2,
      blobCacheHits: 0,
    })
    const payload = await body(await get('codebaseId=repo&from=1&to=3&path=README.md'))
    expect(payload.mode).toBe('file')
    expect(payload.path).toBe('README.md')
    expect((payload.entry as { path: string }).path).toBe('README.md')
    expect(payload.bodyFetches).toBe(2)
    expect(compareRevisions).toHaveBeenCalledWith(1, 3, expect.objectContaining({ path: 'README.md' }))
  })

  it('surfaces an honest error envelope for an expired revision window', async () => {
    compareRevisions.mockResolvedValue({
      ok: false,
      retention: { min: 5, max: 9, retainedVersions: 4 },
      error: { code: 'revision_expired', message: 'Revision 1 is outside retained history.' },
    })
    const response = await get('codebaseId=repo&from=1&to=2')
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatchObject({ code: 'revision_expired' })
    expect(payload.retention).toEqual({ min: 5, max: 9, retainedVersions: 4 })
  })

  it('rejects a non-integer revision pair', async () => {
    const response = await get('codebaseId=repo&from=abc&to=3')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'revision_pair_required' })
  })

  it('404s when the requested file is not in the compare result', async () => {
    compareRevisions.mockResolvedValue({ ok: true, leftRevision: 1, rightRevision: 3, entries: [] })
    const response = await get('codebaseId=repo&from=1&to=3&path=missing.txt')
    expect(response.status).toBe(404)
    expect((await body(response)).error).toMatchObject({ code: 'file_not_found' })
  })
})
