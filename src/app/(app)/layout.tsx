import { AppShell } from '@/components/shell/app-shell'
import { currentServiceAdmin } from '@/lib/service-admin'

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const serviceAdmin = Boolean(await currentServiceAdmin())
  return <AppShell serviceAdmin={serviceAdmin}>{children}</AppShell>
}
