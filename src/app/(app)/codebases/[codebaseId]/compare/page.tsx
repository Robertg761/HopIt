import { ReviewPage } from '@/components/features/review/review-page'

export default async function CodebaseComparePage({
  params,
}: {
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <ReviewPage mode="compare" codebaseId={codebaseId} />
}
