import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route is a thin, read-only wrapper over the backend's listReleases
// method (GR-B4, decisions §9). These tests mock that backend service (as
// well as auth + config), so they exercise the route's request/response
// mapping, not the releases store itself (covered by
// packages/agent/test/release.test.js).

const compareRevisions = vi.fn()
const listReleases = vi.fn()
const cloudActorFromRequest = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')
const missingCloudBackendConfig = vi.fn(() => [] as string[])

vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ compareRevisions, listReleases }),
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
  return GET(new Request(`https://app.test/api/codebases/releases?${query}`))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  cloudActorFromRequest.mockResolvedValue({ userId: 'user_1', sessionId: 'sess_1' })
  configuredCloudBackend.mockReturnValue('d1')
  missingCloudBackendConfig.mockReturnValue([])
  compareRevisions.mockResolvedValue({ ok: false, error: { code: 'revision_expired', message: 'x' } })
  listReleases.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/codebases/releases', () => {
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

  it('requires the D1 backend', async () => {
    configuredCloudBackend.mockReturnValue('memory')
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(503)
    expect((await body(response)).error).toMatchObject({ code: 'd1_required' })
  })

  it('returns browser_auth_required when there is no authenticated user', async () => {
    cloudActorFromRequest.mockResolvedValue(null)
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(401)
    expect((await body(response)).error).toMatchObject({ code: 'browser_auth_required' })
  })

  it('surfaces releases_auth_failed when the auth check throws', async () => {
    cloudActorFromRequest.mockRejectedValue(new Error('clerk exploded'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'releases_auth_failed' })
  })

  it('authorizes the read via a compareRevisions probe, then reports the release list', async () => {
    listReleases.mockResolvedValue([
      { releaseId: 'rel_1', name: 'v1.0', notes: 'First cut', pinnedRevision: 2, createdByUserId: 'user_1', createdAt: '2026-07-24T00:00:00.000Z' },
    ])

    const response = await get('codebaseId=repo')
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(compareRevisions).toHaveBeenCalledWith(0, 0, expect.objectContaining({ codebaseId: 'repo' }))
    expect(listReleases).toHaveBeenCalledWith('repo')
    expect(payload.releases).toEqual([
      { releaseId: 'rel_1', name: 'v1.0', notes: 'First cut', pinnedRevision: 2, createdByUserId: 'user_1', createdAt: '2026-07-24T00:00:00.000Z' },
    ])
  })

  it('defaults notes to null when the backend omits it', async () => {
    listReleases.mockResolvedValue([
      { releaseId: 'rel_1', name: 'v1.0', pinnedRevision: 1, createdByUserId: 'user_1', createdAt: '2026-07-24T00:00:00.000Z' },
    ])
    const payload = await body(await get('codebaseId=repo'))
    expect((payload.releases as Array<{ notes: unknown }>)[0].notes).toBeNull()
  })

  it('surfaces releases_read_failed when the backend read throws', async () => {
    listReleases.mockRejectedValue(new Error('d1 unreachable'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'releases_read_failed' })
  })
})
