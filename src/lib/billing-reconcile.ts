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
  for (const event of events) {
    const current = await readCloudTenantSubscription(event.tenantId)
    if (shouldPreserveRevokedEntitlement(current, event)) {
      preservedRevocations += 1
      continue
    }
    const result = await applyCloudBillingEvent(event) as { applied?: boolean; reason?: string }
    if (result?.applied) applied += 1
    if (result?.reason === 'duplicate') duplicates += 1
  }
  return { ok: true, checked: events.length, applied, duplicates, preservedRevocations }
}
