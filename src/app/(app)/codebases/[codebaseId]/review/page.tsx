import { ReviewPage } from '@/components/features/review/review-page'

export default async function CodebaseReviewPage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <ReviewPage mode="review" codebaseId={codebaseId} />
}
