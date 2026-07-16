// Backend (Plane A) quota gate: Phase 3 Stage 3.
//
// The Next backend owns the subscription/seat/codebase-count gate (the counts
// the tenant CAN influence through the dashboard); the Cloudflare Worker owns the
// un-bypassable storage + daily-write ceilings. Codebase count is computed on
// read at create time (a cold path) rather than maintained, so there is no hot-
// path bookkeeping here. Caps come from the same owner-tunable env knobs the
// Worker reads, so free/paid limits stay in one conceptual place per plan.

export const BACKEND_QUOTA_DEFAULTS = {
  free: { codebases: 1 },
  paid: { codebases: 1_000_000 },
  paid_storage: { codebases: 1_000_000 },
}

function numberFromEnv(value, fallback) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function normalizePlan(plan) {
  const normalized = String(plan ?? '').toLowerCase()
  if (normalized === 'paid_storage' || normalized === 'plus_storage') return 'paid_storage'
  if (normalized === 'paid' || normalized === 'plus') return 'paid'
  return 'free'
}

export function resolveCodebaseLimit(env = {}, plan = 'free') {
  const normalized = normalizePlan(plan)
  if (normalized === 'free') {
    return numberFromEnv(env.HOPIT_QUOTA_FREE_CODEBASES, BACKEND_QUOTA_DEFAULTS.free.codebases)
  }
  if (normalized === 'paid_storage') {
    return numberFromEnv(
      env.HOPIT_QUOTA_PLUS_STORAGE_CODEBASES ?? env.HOPIT_QUOTA_PAID_STORAGE_CODEBASES,
      BACKEND_QUOTA_DEFAULTS.paid_storage.codebases,
    )
  }
  return numberFromEnv(env.HOPIT_QUOTA_PAID_CODEBASES, BACKEND_QUOTA_DEFAULTS.paid.codebases)
}

// Storage + daily-write caps mirror the Worker's quota.js so the dashboard can
// surface the SAME limits the Worker enforces. (The Worker runs in a separate
// Cloudflare bundle and cannot import this Node module: the same reason
// server-actor-token logic is mirrored on both sides.) The Worker remains the
// authoritative enforcement point; this is display-only on Plane A.
const STORAGE_DAILY_DEFAULTS = {
  free: { storageBytes: 2_000_000_000, dailyWrites: 2_000 },
  paid: { storageBytes: 30_000_000_000, dailyWrites: 20_000 },
  paid_storage: { storageBytes: 100_000_000_000, dailyWrites: 20_000 },
  warnRatio: 0.8,
}

export function resolvePlanLimits(env = {}, plan = 'free') {
  const normalized = normalizePlan(plan)
  const base = STORAGE_DAILY_DEFAULTS[normalized]
  if (normalized === 'paid_storage') {
    return {
      plan: normalized,
      storageBytes: numberFromEnv(
        env.HOPIT_QUOTA_PLUS_STORAGE_BYTES ?? env.HOPIT_QUOTA_PAID_STORAGE_BYTES,
        base.storageBytes,
      ),
      dailyWrites: numberFromEnv(
        env.HOPIT_QUOTA_PLUS_STORAGE_DAILY_WRITES ?? env.HOPIT_QUOTA_PAID_STORAGE_DAILY_WRITES,
        base.dailyWrites,
      ),
      codebases: resolveCodebaseLimit(env, normalized),
    }
  }
  const prefix = normalized === 'paid' ? 'PAID' : 'FREE'
  return {
    plan: normalized,
    storageBytes: numberFromEnv(env[`HOPIT_QUOTA_${prefix}_STORAGE_BYTES`], base.storageBytes),
    dailyWrites: numberFromEnv(env[`HOPIT_QUOTA_${prefix}_DAILY_WRITES`], base.dailyWrites),
    codebases: resolveCodebaseLimit(env, normalized),
  }
}

export function warnRatioFromEnv(env = {}) {
  const ratio = Number(env.HOPIT_QUOTA_WARN_RATIO)
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : STORAGE_DAILY_DEFAULTS.warnRatio
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

function meterState({ used, limit, warnRatio }) {
  if (!(limit > 0)) return 'ok'
  const ratio = used / limit
  if (ratio >= 1) return 'block'
  if (ratio >= warnRatio) return 'warn'
  return 'ok'
}

function meterLine({ used, limit, warnRatio, extra = {} }) {
  return { used, limit, ratio: limit > 0 ? used / limit : 0, state: meterState({ used, limit, warnRatio }), ...extra }
}

export function computeUsageStatus({ usage, limits, warnRatio, day = utcDay(), codebaseCount = null }) {
  const storageUsed = Number(usage?.storage_bytes ?? 0)
  const writesUsed = usage?.write_day === day ? Number(usage?.rows_written_today ?? 0) : 0
  const status = {
    plan: limits.plan,
    day,
    storage: meterLine({ used: storageUsed, limit: limits.storageBytes, warnRatio }),
    dailyWrites: meterLine({ used: writesUsed, limit: limits.dailyWrites, warnRatio, extra: { day } }),
  }
  if (codebaseCount != null) {
    status.codebases = meterLine({ used: codebaseCount, limit: limits.codebases, warnRatio })
  }
  return status
}

// Seat / subscription gates are stubbed to always-allow for this stage (billing
// lands in Stage 5). They are shaped as functions so Stage 5 fills in the real
// entitlement lookup without changing the call sites in createCodebase.
export function assertSeatAvailable() {
  return { allowed: true }
}

export function assertSubscriptionActive() {
  return { allowed: true }
}

// Tenant auto-provision (Phase 3 §2e / Stage 6 signup funnel). On a new tenant's
// first authenticated request the backend ensures exactly one tenant_usage row
// exists with the free plan: no card, no owner-email gate. Idempotent by the
// tenant_id primary key: `on conflict do nothing` so a second request never
// duplicates the row NOR resets a plan billing later set to 'paid'. Mirrors the
// Worker's buildMeterUpsertStatement column shape (plan defaults 'free' on
// insert, never overwritten) so provisioning and metering agree on the row. This
// write runs on the admin proxy path (not the server-actor tier, whose firewall
// forbids tenant_usage mutation), matching the meter/provisioning note in
// scoped-sql.js.
export function buildTenantProvisionStatement({ tenantId, plan = 'free', now = new Date().toISOString() }) {
  return {
    sql: `insert into tenant_usage (tenant_id, plan, storage_bytes, write_day, rows_written_today, created_at, updated_at)
      values (?, ?, 0, null, 0, ?, ?)
      on conflict(tenant_id) do nothing`,
    params: [tenantId, normalizePlan(plan), now, now],
  }
}

export class QuotaExceededError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'QuotaExceededError'
    this.code = detail.code ?? 'quota_exceeded'
    this.detail = { reason: this.code, ...detail }
  }
}
