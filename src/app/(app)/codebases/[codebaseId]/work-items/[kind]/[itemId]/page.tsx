import { WorkItemDetail } from '@/components/features/work/work-item-detail'

export default async function CodebaseWorkItemDetailRoute({
  params,
}: {
  params: Promise<{ codebaseId: string; kind: string; itemId: string }>
}) {
  const { codebaseId, kind, itemId } = await params
  return <WorkItemDetail codebaseId={codebaseId} kind={kind} itemId={itemId} />
}
