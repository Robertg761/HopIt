import { HopItDashboardPage } from '@/website/components/command-deck-app'

export default async function CodebaseComparePage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <HopItDashboardPage view="compare" codebaseId={codebaseId} />
}
