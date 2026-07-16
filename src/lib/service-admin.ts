import { auth, currentUser } from '@clerk/nextjs/server'
import { mintServerActorToken } from '@hopit/backend-d1'

import { planCatalog } from '@/lib/billing-plans'
import { isBillingEnabled } from '@/lib/stripe-billing'

export type ServiceAdminActor = {
  userId: string
  email: string
}

type MarginAssumptions = {
  providerRate: number
  providerFixedUsd: number
  r2PerGbUsd: number
  d1PerMillionWritesUsd: number
  opsHeadroomPerPaidTenantUsd: number
  platformBaseUsd: number
}

export async function currentServiceAdmin(): Promise<ServiceAdminActor | null> {
  const { userId } = await auth()
  if (!userId) return null
  const expectedEmail = normalizeEmail(process.env.HOPIT_OWNER_EMAIL)
  if (!expectedEmail) return null
  const user = await currentUser()
  const primary = user?.primaryEmailAddress
  if (primary?.verification?.status !== 'verified') return null
  const email = normalizeEmail(primary.emailAddress)
  return email === expectedEmail ? { userId, email } : null
}

export async function requireServiceAdmin() {
  const actor = await currentServiceAdmin()
  if (!actor) throw new ServiceAdminAccessError()
  return actor
}

export class ServiceAdminAccessError extends Error {
  status = 403

  constructor() {
    super('This account is not authorized to operate the HopIt service.')
    this.name = 'ServiceAdminAccessError'
  }
}

export async function requestServiceOperations(
  actor: ServiceAdminActor,
  init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {},
) {
  const baseUrl = workerBaseUrl()
  const secret = process.env.HOPIT_D1_SERVER_ACTOR_SECRET?.trim()
  if (!secret) throw new Error('HOPIT_D1_SERVER_ACTOR_SECRET is not configured.')
  const token = mintServerActorToken({ userId: actor.userId, secret })
  const response = await fetch(`${baseUrl}/admin/operations`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const envelope = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || envelope?.success === false) {
    const errors = Array.isArray(envelope?.errors) ? envelope.errors : []
    const detail = errors
      .map((entry) => record(entry)?.message)
      .find((message): message is string => typeof message === 'string')
    throw new Error(detail ?? `Operations backend returned ${response.status}.`)
  }
  return record(envelope?.result) ?? {}
}

export function serviceAdminRuntimeConfig() {
  const deploymentUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    ?? process.env.VERCEL_URL?.trim()
    ?? null
  return {
    billingEnabled: isBillingEnabled(),
    billingConfigured: Boolean(
      process.env.STRIPE_SECRET_KEY?.trim()
      && process.env.STRIPE_WEBHOOK_SECRET?.trim()
      && process.env.STRIPE_PRICE_PLUS?.trim()
      && process.env.STRIPE_PRICE_PLUS_STORAGE?.trim(),
    ),
    signupMode: process.env.HOPIT_AUTH_PROVIDER === 'clerk' ? 'clerk' : 'other',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    deployment: {
      url: deploymentUrl ? `https://${deploymentUrl.replace(/^https?:\/\//, '')}` : null,
      region: process.env.VERCEL_REGION ?? null,
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      commitRef: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    features: {
      multiTenant: enabled(process.env.HOPIT_MULTITENANT),
      quotaEnforcement: enabled(process.env.HOPIT_ENFORCE_QUOTA),
      billing: isBillingEnabled(),
      clerk: process.env.HOPIT_AUTH_PROVIDER === 'clerk',
    },
    configured: {
      ownerEmail: Boolean(process.env.HOPIT_OWNER_EMAIL?.trim()),
      serverActor: Boolean(process.env.HOPIT_D1_SERVER_ACTOR_SECRET?.trim()),
      worker: Boolean(process.env.HOPIT_D1_API_BASE_URL?.trim()),
      stripeSecret: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
      stripeWebhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim()),
      plusPrice: Boolean(process.env.STRIPE_PRICE_PLUS?.trim()),
      plusStoragePrice: Boolean(process.env.STRIPE_PRICE_PLUS_STORAGE?.trim()),
    },
    plans: {
      free: planCatalog.free,
      plus: planCatalog.plus,
      plusStorage: planCatalog.plus_storage,
    },
    links: {
      stripe: 'https://dashboard.stripe.com/',
      vercel: deploymentUrl ? `https://vercel.com/robertg761s-projects/hopit` : null,
      worker: process.env.HOPIT_D1_API_BASE_URL?.trim().replace(/\/query\/?$/, '') ?? null,
    },
  }
}

export function serviceEconomics(operations: Record<string, unknown>) {
  const totals = record(operations.totals) ?? {}
  const tenants = Array.isArray(operations.tenants) ? operations.tenants.map(record).filter(Boolean) : []
  const assumptions: MarginAssumptions = {
    providerRate: envNumber('HOPIT_MARGIN_PROVIDER_RATE', 0.05),
    providerFixedUsd: envNumber('HOPIT_MARGIN_PROVIDER_FIXED_USD', 0.5),
    r2PerGbUsd: envNumber('HOPIT_MARGIN_R2_PER_GB_USD', 0.015),
    d1PerMillionWritesUsd: envNumber('HOPIT_MARGIN_D1_PER_MILLION_WRITES_USD', 1),
    opsHeadroomPerPaidTenantUsd: envNumber('HOPIT_MARGIN_OPS_HEADROOM_PER_TENANT_USD', 0.4),
    platformBaseUsd: envNumber('HOPIT_MARGIN_PLATFORM_BASE_USD', 5),
  }
  let grossMrrUsd = 0
  let paidTenants = 0
  for (const tenant of tenants) {
    const subscription = record(tenant?.subscription)
    if (subscription?.entitlementActive !== true) continue
    const price = subscription.planKey === 'plus_storage' ? 15 : subscription.planKey === 'plus' ? 10 : 0
    if (!price) continue
    grossMrrUsd += price
    paidTenants += 1
  }
  const storageGb = number(totals.totalStorageBytes) / 1_000_000_000
  const monthlyWriteRunRate = number(totals.rowsWrittenToday) * 30
  const providerFeesUsd = grossMrrUsd * assumptions.providerRate + paidTenants * assumptions.providerFixedUsd
  const storageUsd = storageGb * assumptions.r2PerGbUsd
  const writesUsd = monthlyWriteRunRate / 1_000_000 * assumptions.d1PerMillionWritesUsd
  const opsHeadroomUsd = paidTenants * assumptions.opsHeadroomPerPaidTenantUsd
  const modeledCostUsd = providerFeesUsd + storageUsd + writesUsd + opsHeadroomUsd + assumptions.platformBaseUsd
  const marginRatio = grossMrrUsd > 0 ? (grossMrrUsd - modeledCostUsd) / grossMrrUsd : null

  return {
    grossMrrUsd,
    paidTenants,
    modeledCostUsd,
    marginRatio,
    targetFloorRatio: 0.5,
    storageGb,
    monthlyWriteRunRate,
    costLines: { providerFeesUsd, storageUsd, writesUsd, opsHeadroomUsd, platformBaseUsd: assumptions.platformBaseUsd },
    assumptions,
    planGuardrails: [
      planGuardrail('plus', 10, 30, 20_000, assumptions),
      planGuardrail('plus_storage', 15, 100, 20_000, assumptions),
    ],
  }
}

function planGuardrail(
  planKey: string,
  revenueUsd: number,
  storageGb: number,
  dailyWrites: number,
  assumptions: MarginAssumptions,
) {
  const costUsd = revenueUsd * assumptions.providerRate
    + assumptions.providerFixedUsd
    + storageGb * assumptions.r2PerGbUsd
    + dailyWrites * 30 / 1_000_000 * assumptions.d1PerMillionWritesUsd
    + assumptions.opsHeadroomPerPaidTenantUsd
  return { planKey, revenueUsd, costUsd, marginRatio: (revenueUsd - costUsd) / revenueUsd }
}

function workerBaseUrl() {
  const configured = process.env.HOPIT_D1_API_BASE_URL?.trim().replace(/\/+$/, '')
  if (!configured || configured === 'https://api.cloudflare.com/client/v4') {
    throw new Error('The typed operations console requires the HopIt D1 Worker URL.')
  }
  return configured.endsWith('/query') ? configured.slice(0, -'/query'.length) : configured
}

function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function enabled(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
