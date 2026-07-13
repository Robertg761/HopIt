import { defineBackendMethods } from './method-support.js'

const BILLING_PLANS = new Set(['plus', 'plus_storage'])

function text(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function billingPlan(value) {
  const normalized = text(value, 'planKey').toLowerCase()
  if (!BILLING_PLANS.has(normalized)) throw new Error(`Unsupported billing plan: ${normalized}.`)
  return normalized
}

function entitlementPlan(planKey, active) {
  if (!active) return 'free'
  return planKey === 'plus_storage' ? 'paid_storage' : 'paid'
}

export function buildBillingEventStatements(input = {}) {
  const eventId = text(input.eventId, 'eventId')
  const provider = text(input.provider, 'provider').toLowerCase()
  const tenantId = text(input.tenantId, 'tenantId')
  const planKey = billingPlan(input.planKey)
  const status = text(input.status, 'status').toLowerCase()
  const eventCreatedAt = text(input.eventCreatedAt, 'eventCreatedAt')
  const receivedAt = text(input.receivedAt ?? new Date().toISOString(), 'receivedAt')
  const entitlementActive = input.entitlementActive === true ? 1 : 0
  const cancelAtPeriodEnd = input.cancelAtPeriodEnd === true ? 1 : 0
  const plan = entitlementPlan(planKey, entitlementActive === 1)

  return [
    {
      sql: `insert into billing_webhook_events (event_id, provider, event_created_at, received_at)
        values (?, ?, ?, ?)`,
      params: [eventId, provider, eventCreatedAt, receivedAt],
    },
    {
      sql: `insert into tenant_usage (tenant_id, plan, storage_bytes, write_day, rows_written_today, created_at, updated_at)
        values (?, 'free', 0, null, 0, ?, ?)
        on conflict(tenant_id) do nothing`,
      params: [tenantId, receivedAt, receivedAt],
    },
    {
      sql: `insert into subscriptions (
          tenant_id, provider, provider_customer_id, provider_subscription_id,
          plan_key, status, entitlement_active, cancel_at_period_end,
          current_period_end, last_event_id, last_event_created_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(tenant_id) do update set
          provider = excluded.provider,
          provider_customer_id = coalesce(excluded.provider_customer_id, subscriptions.provider_customer_id),
          provider_subscription_id = coalesce(excluded.provider_subscription_id, subscriptions.provider_subscription_id),
          plan_key = excluded.plan_key,
          status = excluded.status,
          entitlement_active = excluded.entitlement_active,
          cancel_at_period_end = excluded.cancel_at_period_end,
          current_period_end = excluded.current_period_end,
          last_event_id = excluded.last_event_id,
          last_event_created_at = excluded.last_event_created_at,
          updated_at = excluded.updated_at
        where excluded.last_event_created_at >= subscriptions.last_event_created_at`,
      params: [
        tenantId,
        provider,
        optionalText(input.providerCustomerId),
        optionalText(input.providerSubscriptionId),
        planKey,
        status,
        entitlementActive,
        cancelAtPeriodEnd,
        optionalText(input.currentPeriodEnd),
        eventId,
        eventCreatedAt,
        receivedAt,
        receivedAt,
      ],
    },
    {
      sql: `update tenant_usage
        set plan = coalesce((
          select case
            when entitlement_active = 0 then 'free'
            when plan_key = 'plus_storage' then 'paid_storage'
            else 'paid'
          end
          from subscriptions where tenant_id = ?
        ), ?), updated_at = ?
        where tenant_id = ?`,
      params: [tenantId, plan, receivedAt, tenantId],
    },
  ]
}

function subscriptionRecord(row) {
  if (!row) return null
  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    providerCustomerId: row.provider_customer_id ?? null,
    providerSubscriptionId: row.provider_subscription_id ?? null,
    planKey: row.plan_key,
    status: row.status,
    entitlementActive: Number(row.entitlement_active) === 1,
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    currentPeriodEnd: row.current_period_end ?? null,
    lastEventId: row.last_event_id,
    lastEventCreatedAt: row.last_event_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function attachBillingMethods(Backend) {
  defineBackendMethods(Backend, {
    async applyBillingEvent(input = {}) {
      if (!this.config.multiTenant) return { applied: false, reason: 'disabled', subscription: null }
      await this.ensureSchema()
      const statements = buildBillingEventStatements(input)
      try {
        await this.queryBatch(statements)
      } catch (error) {
        if (/unique constraint failed: billing_webhook_events\.event_id|constraint.*event_id/i.test(error?.message ?? '')) {
          return { applied: false, reason: 'duplicate', subscription: null }
        }
        throw error
      }
      const subscription = await this.first('select * from subscriptions where tenant_id = ? limit 1', [input.tenantId])
      return { applied: true, reason: null, subscription: subscriptionRecord(subscription) }
    },

    async readTenantSubscription({ tenantId } = {}) {
      const id = text(tenantId, 'tenantId')
      await this.ensureSchema()
      return subscriptionRecord(await this.first('select * from subscriptions where tenant_id = ? limit 1', [id]))
    },

    async readSubscriptionByProviderCustomer({ provider, providerCustomerId } = {}) {
      const normalizedProvider = text(provider, 'provider').toLowerCase()
      const customerId = text(providerCustomerId, 'providerCustomerId')
      await this.ensureSchema()
      return subscriptionRecord(await this.first(
        'select * from subscriptions where provider = ? and provider_customer_id = ? limit 1',
        [normalizedProvider, customerId],
      ))
    },
  })
}
