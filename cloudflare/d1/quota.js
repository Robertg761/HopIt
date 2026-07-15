// Per-tenant usage metering + quota enforcement: Phase 3 Stage 2-3
// (HOPIT_MULTITENANT master flag; HOPIT_ENFORCE_QUOTA hard-block sub-gate).
//
// Pure, side-effect-free helpers shared by the Worker's mutation path. The
// Worker is the authoritative (un-bypassable) enforcement point for storage
// bytes and daily D1 writes because the agent's env is tenant-controlled: a
// hostile agent can raise its own local budget, but it cannot forge these caps.
//
// Metering model (documented tradeoff):
//   * Daily D1 rows written: the binding cost line. MAINTAINED tally: the Worker
//     counts the mutating statements it is about to run and folds ONE meter
//     upsert into the same batch, so a tenant cannot journal without also
//     incrementing its meter (they commit or roll back together). Cost: exactly
//     +1 D1 row written per mutating batch (the meter row itself), which is NOT
//     counted against the tenant's own budget. Reads are never metered.
//   * Storage bytes: MAINTAINED additive tally of guarded file sizes, folded
//     into the same meter upsert. Approximate (a re-save of an unchanged path
//     adds its size again) and reconciled nightly against an R2/D1 prefix scan;
//     the exact-delta alternative would cost a read-before-write on every save.
//   * Codebase count: COMPUTED ON READ in the Next backend at create time (a
//     cold path), never maintained here, so the hot write path stays at +1 row.

export const QUOTA_DEFAULTS = {
  // Free caps (design §2c / §4): keeps ~5 free tenants inside the 10 GB R2 free
  // ceiling and bounds the one cost line that can go margin-negative.
  free: { storageBytes: 2_000_000_000, dailyWrites: 2_000, codebases: 1 },
  // Paid caps (design §4.b): 30 GB included; a daily-write fair-use backstop.
  paid: { storageBytes: 30_000_000_000, dailyWrites: 20_000, codebases: 1_000_000 },
  paid_storage: { storageBytes: 100_000_000_000, dailyWrites: 20_000, codebases: 1_000_000 },
  warnRatio: 0.8,
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

// A single indexed read resolves the tenant's plan; caps derive from that plan
// via owner-tunable env knobs (so retuning caps never requires a data migration).
export function resolvePlanLimits(env = {}, plan = 'free') {
  const normalized = normalizePlan(plan)
  if (normalized === 'paid_storage') {
    return {
      plan: 'paid_storage',
      storageBytes: numberFromEnv(
        env.HOPIT_QUOTA_PLUS_STORAGE_BYTES ?? env.HOPIT_QUOTA_PAID_STORAGE_BYTES,
        QUOTA_DEFAULTS.paid_storage.storageBytes,
      ),
      dailyWrites: numberFromEnv(
        env.HOPIT_QUOTA_PLUS_STORAGE_DAILY_WRITES ?? env.HOPIT_QUOTA_PAID_STORAGE_DAILY_WRITES,
        QUOTA_DEFAULTS.paid_storage.dailyWrites,
      ),
      codebases: numberFromEnv(
        env.HOPIT_QUOTA_PLUS_STORAGE_CODEBASES ?? env.HOPIT_QUOTA_PAID_STORAGE_CODEBASES,
        QUOTA_DEFAULTS.paid_storage.codebases,
      ),
    }
  }
  if (normalized === 'paid') {
    return {
      plan: 'paid',
      storageBytes: numberFromEnv(env.HOPIT_QUOTA_PAID_STORAGE_BYTES, QUOTA_DEFAULTS.paid.storageBytes),
      dailyWrites: numberFromEnv(env.HOPIT_QUOTA_PAID_DAILY_WRITES, QUOTA_DEFAULTS.paid.dailyWrites),
      codebases: numberFromEnv(env.HOPIT_QUOTA_PAID_CODEBASES, QUOTA_DEFAULTS.paid.codebases),
    }
  }
  return {
    plan: 'free',
    storageBytes: numberFromEnv(env.HOPIT_QUOTA_FREE_STORAGE_BYTES, QUOTA_DEFAULTS.free.storageBytes),
    dailyWrites: numberFromEnv(env.HOPIT_QUOTA_FREE_DAILY_WRITES, QUOTA_DEFAULTS.free.dailyWrites),
    codebases: numberFromEnv(env.HOPIT_QUOTA_FREE_CODEBASES, QUOTA_DEFAULTS.free.codebases),
  }
}

export function warnRatioFromEnv(env = {}) {
  const ratio = Number(env.HOPIT_QUOTA_WARN_RATIO)
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : QUOTA_DEFAULTS.warnRatio
}

// Enforcement (hard block on writes) only fires with BOTH the master multi-tenant
// flag and the Stage-3 HOPIT_ENFORCE_QUOTA sub-gate on. Metering (the folded
// upsert) rides the master flag alone, matching the staged plan (Stage 2 meters,
// Stage 3 enforces).
export function isQuotaEnforced(env = {}) {
  return /^(1|true|yes|on)$/i.test(String(env?.HOPIT_ENFORCE_QUOTA ?? ''))
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

// The rolling daily counter resets when the stored write_day is not today, so a
// single row per tenant carries the "today" budget without a scheduled reset job.
export function rowsUsedToday(usage, day) {
  if (!usage) return 0
  return usage.write_day === day ? Number(usage.rows_written_today ?? 0) : 0
}

export function meterState({ used, limit, warnRatio }) {
  if (!(limit > 0)) return 'ok'
  const ratio = used / limit
  if (ratio >= 1) return 'block'
  if (ratio >= warnRatio) return 'warn'
  return 'ok'
}

function meterLine({ used, limit, warnRatio, extra = {} }) {
  return {
    used,
    limit,
    ratio: limit > 0 ? used / limit : 0,
    state: meterState({ used, limit, warnRatio }),
    ...extra,
  }
}

// Legible per-tenant usage + limits + warn/block state for the status surface.
export function computeUsageStatus({ usage, limits, warnRatio, day = utcDay(), codebaseCount = null }) {
  const storageUsed = Number(usage?.storage_bytes ?? 0)
  const writesUsed = rowsUsedToday(usage, day)
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

// Decide whether a mutating batch may proceed. Returns null when allowed, or a
// typed rejection (never throws) so the caller can fail the write CLEANLY -
// reads/export are never routed here, and a blocked write loses no data (the
// agent holds the change on local disk and retries).
export function evaluateWriteQuota({ usage, limits, day = utcDay(), rowsDelta = 0, storageDelta = 0 }) {
  const writesUsed = rowsUsedToday(usage, day)
  if (limits.dailyWrites > 0 && rowsDelta > 0 && writesUsed + rowsDelta > limits.dailyWrites) {
    return {
      code: 'quota_exceeded_daily',
      kind: 'daily_writes',
      message: `Daily write quota exceeded for ${day} (${writesUsed + rowsDelta}/${limits.dailyWrites} rows). Edits are held locally and retried after the UTC day rolls.`,
      limit: limits.dailyWrites,
      used: writesUsed,
      requested: rowsDelta,
      plan: limits.plan,
    }
  }
  const storageUsed = Number(usage?.storage_bytes ?? 0)
  if (limits.storageBytes > 0 && storageDelta > 0 && storageUsed + storageDelta > limits.storageBytes) {
    return {
      code: 'quota_exceeded_storage',
      kind: 'storage',
      message: `Storage quota exceeded (${storageUsed + storageDelta}/${limits.storageBytes} bytes). The change is held locally; free space (delete/GC) and retry.`,
      limit: limits.storageBytes,
      used: storageUsed,
      requested: storageDelta,
      plan: limits.plan,
    }
  }
  return null
}

// The single meter upsert folded into the tenant's write batch. Storage receives
// a trusted net delta calculated by the Worker from the current file row and is
// clamped at zero; the daily counter resets on a day roll inside the same
// statement. `plan` is only set on first insert (default 'free') and never
// overwritten here, so billing/provisioning owns the plan column.
export function buildMeterUpsertStatement({ tenantId, day = utcDay(), rowsDelta = 0, storageDelta = 0, now = new Date().toISOString() }) {
  return {
    sql: `insert into tenant_usage (tenant_id, plan, storage_bytes, write_day, rows_written_today, created_at, updated_at)
      values (?, 'free', max(0, ?), ?, ?, ?, ?)
      on conflict(tenant_id) do update set
        storage_bytes = max(0, tenant_usage.storage_bytes + ?),
        rows_written_today = case when tenant_usage.write_day = ? then tenant_usage.rows_written_today + ? else ? end,
        write_day = ?,
        updated_at = ?`,
    params: [tenantId, storageDelta, day, rowsDelta, now, now, storageDelta, day, rowsDelta, rowsDelta, day, now],
  }
}
