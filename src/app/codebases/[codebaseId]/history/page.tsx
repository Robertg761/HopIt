import { HopItDashboardPage } from '@/website/components/command-deck-app'

export default async function CodebaseHistoryPage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <HopItDashboardPage view="history" codebaseId={codebaseId} />
}
