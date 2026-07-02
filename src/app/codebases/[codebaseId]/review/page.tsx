import { HopItDashboardPage } from '@/website/components/command-deck-app'

export default async function CodebaseReviewPage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <HopItDashboardPage view="review" codebaseId={codebaseId} />
}
