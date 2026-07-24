import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route is a thin, read-only wrapper over the backend's readCodebaseSettings
// method (GR-C1, decisions §6). These tests mock that backend service (as well
// as auth + config), so they exercise the route's request/response mapping, not
// the derived-path classification engine.

const compareRevisions = vi.fn()
const readCodebaseSettings = vi.fn()
const cloudActorFromRequest = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')
const missingCloudBackendConfig = vi.fn(() => [] as string[])

vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ compareRevisions, readCodebaseSettings }),
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
  return GET(new Request(`https://app.test/api/codebases/derived-paths?${query}`))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  cloudActorFromRequest.mockResolvedValue({ userId: 'user_1', sessionId: 'sess_1' })
  configuredCloudBackend.mockReturnValue('d1')
  missingCloudBackendConfig.mockReturnValue([])
  compareRevisions.mockResolvedValue({ ok: false, error: { code: 'revision_expired', message: 'x' } })
  readCodebaseSettings.mockResolvedValue({ derivedPathOverrides: { add: [], remove: [] } })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/codebases/derived-paths', () => {
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

  it('surfaces derived_paths_auth_failed when the auth check throws', async () => {
    cloudActorFromRequest.mockRejectedValue(new Error('clerk exploded'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'derived_paths_auth_failed' })
  })

  it('authorizes the read via a compareRevisions probe, then reports the curated list plus overrides', async () => {
    readCodebaseSettings.mockResolvedValue({ derivedPathOverrides: { add: ['generated'], remove: ['dist'] } })

    const response = await get('codebaseId=repo')
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(compareRevisions).toHaveBeenCalledWith(0, 0, expect.objectContaining({ codebaseId: 'repo' }))
    expect(readCodebaseSettings).toHaveBeenCalledWith('repo')
    expect(payload.builtin).toEqual(expect.arrayContaining(['node_modules', 'dist', 'vendor/bundle']))
    expect(payload.overrides).toEqual({ add: ['generated'], remove: ['dist'] })
  })

  it('defaults overrides to empty arrays when the backend reports none', async () => {
    readCodebaseSettings.mockResolvedValue({})
    const payload = await body(await get('codebaseId=repo'))
    expect(payload.overrides).toEqual({ add: [], remove: [] })
  })

  it('surfaces derived_paths_read_failed when the backend read throws', async () => {
    readCodebaseSettings.mockRejectedValue(new Error('d1 unreachable'))
    const response = await get('codebaseId=repo')
    expect(response.status).toBe(400)
    expect((await body(response)).error).toMatchObject({ code: 'derived_paths_read_failed' })
  })
})
