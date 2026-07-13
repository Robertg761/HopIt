import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

import { buildBillingEventStatements, normalizePlan, resolvePlanLimits } from '@hopit/backend-d1'

describe('billing entitlement persistence', () => {
  it('claims the webhook event first so a replay cannot reapply entitlement writes', () => {
    const statements = buildBillingEventStatements({
      eventId: 'evt_1',
      provider: 'stripe_managed_payments',
      eventCreatedAt: '2026-07-13T12:00:00.000Z',
      receivedAt: '2026-07-13T12:00:01.000Z',
      tenantId: 'user_a',
      providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_a',
      planKey: 'plus_storage',
      status: 'active',
      entitlementActive: true,
      cancelAtPeriodEnd: false,
    })
    expect(statements[0].sql).toMatch(/insert into billing_webhook_events/i)
    expect(statements[0].sql).not.toMatch(/or ignore|do nothing/i)
    expect(statements[2].sql).toMatch(/last_event_created_at/i)
    expect(statements[3].sql).toMatch(/paid_storage/i)
  })

  it('gives Plus Storage the promised 100 GB hard cap and 20k write cap', () => {
    expect(normalizePlan('plus_storage')).toBe('paid_storage')
    expect(resolvePlanLimits({}, 'paid_storage')).toMatchObject({
      plan: 'paid_storage',
      storageBytes: 100_000_000_000,
      dailyWrites: 20_000,
    })
  })

  it('applies, downgrades, and rejects replays in real SQLite without deleting usage', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      create table tenant_usage (
        tenant_id text primary key, plan text not null default 'free', storage_bytes integer not null default 0,
        write_day text, rows_written_today integer not null default 0, created_at text not null, updated_at text not null
      );
      create table subscriptions (
        tenant_id text primary key, provider text not null, provider_customer_id text,
        provider_subscription_id text unique, plan_key text not null, status text not null,
        entitlement_active integer not null default 0, cancel_at_period_end integer not null default 0,
        current_period_end text, last_event_id text not null, last_event_created_at text not null,
        created_at text not null, updated_at text not null
      );
      create table billing_webhook_events (
        event_id text primary key, provider text not null, event_created_at text not null, received_at text not null
      );
    `)

    const apply = (input: Record<string, unknown>) => {
      for (const statement of buildBillingEventStatements(input)) db.prepare(statement.sql).run(...statement.params as never[])
    }
    const base = {
      provider: 'stripe_managed_payments', tenantId: 'user_a', providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_a', planKey: 'plus_storage', cancelAtPeriodEnd: false,
    }
    apply({ ...base, eventId: 'evt_active', eventCreatedAt: '2026-07-13T12:00:00.000Z', receivedAt: 'r1', status: 'active', entitlementActive: true })
    db.prepare(`update tenant_usage set storage_bytes = 42000000000 where tenant_id = 'user_a'`).run()
    expect(db.prepare(`select plan from tenant_usage where tenant_id = 'user_a'`).get()?.plan).toBe('paid_storage')

    expect(() => apply({ ...base, eventId: 'evt_active', eventCreatedAt: '2026-07-13T12:00:00.000Z', receivedAt: 'r2', status: 'active', entitlementActive: true })).toThrow(/unique/i)

    apply({ ...base, eventId: 'evt_canceled', eventCreatedAt: '2026-07-14T12:00:00.000Z', receivedAt: 'r3', status: 'canceled', entitlementActive: false })
    const usage = db.prepare(`select plan, storage_bytes from tenant_usage where tenant_id = 'user_a'`).get()
    expect(usage).toMatchObject({ plan: 'free', storage_bytes: 42_000_000_000 })
    db.close()
  })
})
