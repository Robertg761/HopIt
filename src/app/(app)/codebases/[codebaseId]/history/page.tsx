import { ReviewPage } from '@/components/features/review/review-page'

export default async function CodebaseHistoryPage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <ReviewPage mode="history" codebaseId={codebaseId} />
}
