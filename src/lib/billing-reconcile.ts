import { applyCloudBillingEvent, readCloudTenantSubscription } from '@/lib/cloud-backend'
import {
  isBillingEnabled,
  listStripeSubscriptionEntitlements,
  shouldPreserveRevokedEntitlement,
} from '@/lib/stripe-billing'

export async function reconcileBillingEntitlements() {
  if (!isBillingEnabled()) return { ok: true, skipped: 'billing_disabled' as const }

  const events = await listStripeSubscriptionEntitlements()
  let applied = 0
  let duplicates = 0
  let preservedRevocations = 0
  const failures: Array<{ tenantId: string; message: string }> = []
  for (const event of events) {
    try {
      const current = await readCloudTenantSubscription(event.tenantId)
      if (shouldPreserveRevokedEntitlement(current, event)) {
        preservedRevocations += 1
        continue
      }
      const result = await applyCloudBillingEvent(event) as { applied?: boolean; reason?: string }
      if (result?.applied) applied += 1
      if (result?.reason === 'duplicate') duplicates += 1
    } catch (cause) {
      failures.push({
        tenantId: event.tenantId,
        message: cause instanceof Error ? cause.message : 'Billing entitlement reconciliation failed.',
      })
    }
  }
  return {
    ok: failures.length === 0,
    partial: failures.length > 0 && failures.length < events.length,
    checked: events.length,
    applied,
    duplicates,
    preservedRevocations,
    failures,
  }
}
