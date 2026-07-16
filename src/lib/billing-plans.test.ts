import { describe, expect, it } from 'vitest'

import { billingPlans, planCatalog, planName, planShortName } from './billing-plans'

describe('billing plans', () => {
  it('keeps paid plan values sourced from the shared catalog', () => {
    expect(billingPlans.plus).toBe(planCatalog.plus)
    expect(billingPlans.plus_storage).toBe(planCatalog.plus_storage)
    expect(planCatalog.free.priceUsd).toBe(0)
    expect(planCatalog.plus.storageGb).toBe(30)
    expect(planCatalog.plus_storage.storageGb).toBe(100)
  })

  it('uses safe display fallbacks for unknown plan keys', () => {
    expect(planName('plus')).toBe('HopIt Plus')
    expect(planShortName('plus_storage')).toBe('Plus Storage')
    expect(planShortName('unknown')).toBe('Free')
  })
})
