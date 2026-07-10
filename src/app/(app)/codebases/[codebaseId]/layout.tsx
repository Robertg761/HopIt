import { RepoShell } from '@/components/shell/repo-shell'

export default async function CodebaseLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ codebaseId: string }>
}) {
  const { codebaseId } = await params
  return <RepoShell codebaseId={codebaseId}>{children}</RepoShell>
}
