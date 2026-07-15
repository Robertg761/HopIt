import { describe, expect, it } from 'vitest'

import { buildTenantProvisionStatement, normalizePlan } from '@hopit/backend-d1'

// Phase 3 §2e item 1: tenant auto-provision. The provisioning statement must be
// idempotent (insert ... on conflict do nothing on the tenant_id primary key) so
// a second authenticated request never duplicates the row, and it must NOT carry
// an update clause that could reset a plan billing later set to 'paid'. Billing
// owns the plan column. Proving the exact SQL shape guarantees idempotency by
// construction (the PK + do-nothing conflict), the same pattern the Worker meter
// upsert is unit-tested against.

describe('buildTenantProvisionStatement', () => {
  it('is idempotent: on conflict do nothing, never an update that clobbers the plan', () => {
    const { sql, params } = buildTenantProvisionStatement({ tenantId: 'user_a', now: '2026-07-12T00:00:00.000Z' })
    expect(sql).toMatch(/insert into tenant_usage/i)
    expect(sql).toMatch(/on conflict\(tenant_id\) do nothing/i)
    expect(sql).not.toMatch(/do update/i)
    // tenant_id, plan, created_at, updated_at
    expect(params).toEqual(['user_a', 'free', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'])
  })

  it('defaults a new tenant to the free plan (no card)', () => {
    const { params } = buildTenantProvisionStatement({ tenantId: 'user_b' })
    expect(params[1]).toBe('free')
  })

  it('normalizes an explicit plan through the shared normalizer', () => {
    expect(buildTenantProvisionStatement({ tenantId: 'user_c', plan: 'paid' }).params[1]).toBe('paid')
    expect(buildTenantProvisionStatement({ tenantId: 'user_d', plan: 'garbage' }).params[1]).toBe('free')
    expect(normalizePlan('PAID')).toBe('paid')
  })
})
