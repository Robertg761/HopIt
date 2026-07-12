import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route is a thin, read-only wrapper over the backend's episode + settings
// methods. These tests mock that backend service (as well as auth + config), so
// they exercise the route's request/response mapping, not the episode engine.

const compareRevisions = vi.fn()
const listTrailEpisodes = vi.fn()
const readCodebaseSettings = vi.fn()
const cloudActorFromRequest = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')
const missingCloudBackendConfig = vi.fn(() => [] as string[])

vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ compareRevisions, listTrailEpisodes, readCodebaseSettings }),
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
  return GET(new Request(`https://app.test/api/codebases/episodes?${query}`))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  cloudActorFromRequest.mockResolvedValue({ userId: 'user_1', sessionId: 'sess_1' })
  configuredCloudBackend.mockReturnValue('d1')
  missingCloudBackendConfig.mockReturnValue([])
  compareRevisions.mockResolvedValue({ ok: false, error: { code: 'revision_expired', message: 'x' } })
  listTrailEpisodes.mockResolvedValue([])
  readCodebaseSettings.mockResolvedValue({ trailSummariesEnabled: true, trailSummariesMode: 'metadata' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/codebases/episodes', () => {
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

  it('surfaces episodes_auth_failed when the auth check throws', async () => {
    cloudActorFromRequest.mockRejectedValue(new Error('clerk exploded'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'episodes_auth_failed' })
  })

  it('authorizes the read via a compareRevisions probe, then lists newest-first episodes with settings', async () => {
    listTrailEpisodes.mockResolvedValue([
      { episodeId: 'ep_1_2', fromRevision: 1, toRevision: 2, label: null },
      { episodeId: 'ep_3_5', fromRevision: 3, toRevision: 5, label: 'Wired the trail view' },
    ])
    readCodebaseSettings.mockResolvedValue({ trailSummariesEnabled: true, trailSummariesMode: 'diff' })

    const response = await get('codebaseId=repo')
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload.mode).toBe('episodes')
    // Authorization happens via a compareRevisions probe before listing.
    expect(compareRevisions).toHaveBeenCalledWith(0, 0, expect.objectContaining({ codebaseId: 'repo' }))
    expect(listTrailEpisodes).toHaveBeenCalledWith('repo', { limit: 200 })
    // Backend lists ascending; the route returns newest first.
    expect((payload.episodes as Array<{ episodeId: string }>).map((e) => e.episodeId)).toEqual([
      'ep_3_5',
      'ep_1_2',
    ])
    expect(payload.summaries).toEqual({ enabled: true, mode: 'diff' })
  })

  it('reports the honest disabled-summaries state', async () => {
    readCodebaseSettings.mockResolvedValue({ trailSummariesEnabled: false, trailSummariesMode: 'metadata' })
    const payload = await body(await get('codebaseId=repo'))
    expect(payload.summaries).toEqual({ enabled: false, mode: 'metadata' })
  })

  it('surfaces episodes_read_failed when the backend read throws', async () => {
    listTrailEpisodes.mockRejectedValue(new Error('d1 unreachable'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'episodes_read_failed' })
  })
})
