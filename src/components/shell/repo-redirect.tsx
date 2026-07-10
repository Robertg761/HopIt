'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { useWorkspace } from '@/components/workspace/workspace-provider'
import { repoPath } from '@/components/shell/repo-nav'
import { Skeleton } from '@/components/ui/skeleton'

/** Redirect legacy account-level feature routes into the selected repository. */
export function RepoRedirect({ segment = '' }: { segment?: string }) {
  const router = useRouter()
  const { selectedCodebaseId, status, loading, codebases, codebasesLoading } = useWorkspace()

  React.useEffect(() => {
    if (loading || codebasesLoading) return

    const id =
      selectedCodebaseId ??
      status.codebaseId ??
      codebases[0]?.id ??
      null

    if (!id) {
      router.replace('/codebases')
      return
    }

    router.replace(repoPath(id, segment))
  }, [
    codebases,
    codebasesLoading,
    loading,
    router,
    segment,
    selectedCodebaseId,
    status.codebaseId,
  ])

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-3 px-4 py-10 sm:px-6 lg:px-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
