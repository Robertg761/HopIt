export type BillingPlanKey = 'plus' | 'plus_storage'
export type PlanKey = 'free' | BillingPlanKey

export const planCatalog = {
  free: {
    key: 'free',
    name: 'Free',
    shortName: 'Free',
    priceUsd: 0,
    storageGb: 2,
    dailyWrites: 2_000,
    codebases: 1,
  },
  plus: {
    key: 'plus',
    name: 'HopIt Plus',
    shortName: 'Plus',
    priceUsd: 10,
    storageGb: 30,
    dailyWrites: 20_000,
    codebases: null,
  },
  plus_storage: {
    key: 'plus_storage',
    name: 'HopIt Plus Storage',
    shortName: 'Plus Storage',
    priceUsd: 15,
    storageGb: 100,
    dailyWrites: 20_000,
    codebases: null,
  },
} as const

export const billingPlans = {
  plus: planCatalog.plus,
  plus_storage: planCatalog.plus_storage,
} as const

export function planName(planKey: string | null | undefined) {
  return planKey && planKey in planCatalog
    ? planCatalog[planKey as PlanKey].name
    : planCatalog.free.name
}

export function planShortName(planKey: string | null | undefined) {
  return planKey && planKey in planCatalog
    ? planCatalog[planKey as PlanKey].shortName
    : planCatalog.free.shortName
}
