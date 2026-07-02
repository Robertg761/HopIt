import { WorkItemDetailPage } from '@/website/components/work-item-detail-page'

export default async function CodebaseWorkItemDetailRoute({
  params,
}: {
  params: Promise<{ codebaseId: string; kind: string; itemId: string }>
}) {
  const { codebaseId, kind, itemId } = await params
  return <WorkItemDetailPage codebaseId={codebaseId} kind={kind} itemId={itemId} />
}
