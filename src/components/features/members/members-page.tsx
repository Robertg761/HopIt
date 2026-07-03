'use client'

import * as React from 'react'
import Link from 'next/link'
import { Users } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import {
  fetchInvitations,
  fetchKeyGrantStatus,
  fetchMembers,
  type InvitationsResponse,
  type KeyGrantStatusResponse,
  type MembersResponse,
} from '@/lib/collaboration'

import { InvitationsCard } from './invitations-card'
import { KeyGrantsCard } from './key-grants-card'
import { MembersCard } from './members-card'
import { YouCard } from './you-card'

export function MembersPage() {
  const { status, loading: statusLoading, selectedCodebaseId, refresh } = useWorkspace()
  const codebaseId = selectedCodebaseId ?? status.codebaseId

  const [members, setMembers] = React.useState<MembersResponse | null>(null)
  const [invitations, setInvitations] = React.useState<InvitationsResponse | null>(null)
  const [keys, setKeys] = React.useState<KeyGrantStatusResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    if (!codebaseId) return
    const [membersResult, invitationsResult, keysResult] = await Promise.allSettled([
      fetchMembers(codebaseId),
      fetchInvitations(codebaseId),
      fetchKeyGrantStatus(codebaseId),
    ])
    setMembers(membersResult.status === 'fulfilled' ? membersResult.value : null)
    setInvitations(invitationsResult.status === 'fulfilled' ? invitationsResult.value : null)
    setKeys(keysResult.status === 'fulfilled' ? keysResult.value : null)
    setLoading(false)
  }, [codebaseId])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!codebaseId) {
    return (
      <PageScaffold title="Members" description="People, invitations, and key grants for this codebase.">
        {statusLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <EmptyState
            icon={Users}
            title="No codebase selected"
            description="Pick a codebase to see its members, invitations, and key grants."
            action={
              <Button asChild variant="outline">
                <Link href="/codebases">Browse codebases</Link>
              </Button>
            }
          />
        )}
      </PageScaffold>
    )
  }

  return (
    <PageScaffold title="Members" description="People, invitations, and key grants for this codebase.">
      <YouCard
        requester={status.requester}
        members={members}
        codebaseId={codebaseId}
        onMembers={setMembers}
        refresh={refresh}
      />
      <MembersCard response={members} loading={loading} codebaseId={codebaseId} onMembers={setMembers} />
      <InvitationsCard
        response={invitations}
        loading={loading}
        codebaseId={codebaseId}
        onInvitations={setInvitations}
        refresh={refresh}
      />
      <KeyGrantsCard
        response={keys}
        loading={loading}
        codebaseId={codebaseId}
        canManage={status.requester.isOwner}
        onKeys={setKeys}
      />
    </PageScaffold>
  )
}
