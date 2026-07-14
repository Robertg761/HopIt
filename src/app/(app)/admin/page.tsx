import { notFound } from 'next/navigation'

import { OperationsConsole } from '@/components/features/admin/operations-console'
import { currentServiceAdmin } from '@/lib/service-admin'

export const dynamic = 'force-dynamic'

export default async function AdminOperationsPage() {
  if (!await currentServiceAdmin()) notFound()
  return <OperationsConsole />
}
