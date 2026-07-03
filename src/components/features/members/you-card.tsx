'use client'

import * as React from 'react'
import { Crown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { claimCodebaseOwner, type MembersResponse } from '@/lib/collaboration'
import { formatCount } from '@/lib/client/format'
import type { AgentRequester } from '@/lib/client/agent-status'

import { MonoId, RoleBadge, errorText } from './shared'

export function YouCard({
  requester,
  members,
  codebaseId,
  onMembers,
  refresh,
}: {
  requester: AgentRequester
  members: MembersResponse | null
  codebaseId: string
  onMembers: (response: MembersResponse) => void
  refresh: () => Promise<void>
}) {
  const { toast } = useToast()
  const [claiming, setClaiming] = React.useState(false)
  const claimCapability = members?.capabilities.claimOwner

  async function claim() {
    setClaiming(true)
    try {
      const response = await claimCodebaseOwner({ codebaseId })
      if (response.ok) {
        onMembers(response)
        toast({ title: 'Ownership claimed', description: 'You are now the owner of this codebase.' })
        await refresh()
      } else {
        toast({
          title: 'Could not claim ownership',
          description: errorText(response.error, 'The claim request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not claim ownership',
        description: error instanceof Error ? error.message : 'The claim request failed.',
        variant: 'destructive',
      })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>You</CardTitle>
          <CardDescription>Your access to this codebase in the current session.</CardDescription>
        </div>
        {claimCapability?.enabled ? (
          <Button size="sm" variant="outline" onClick={() => void claim()} disabled={claiming}>
            {claiming ? <Spinner className="size-3.5" /> : <Crown className="size-4" />}
            {claiming ? 'Claiming…' : 'Claim ownership'}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <RoleBadge role={requester.role} />
          {requester.isOwner ? <Badge tone="hop">owner access</Badge> : null}
          <Badge tone="outline">source: {requester.membershipSource}</Badge>
        </div>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Session</dt>
            <dd className="mt-0.5">
              <MonoId value={requester.sessionId} className="max-w-full" />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Files</dt>
            <dd className="mt-0.5">
              {formatCount(requester.visibleFileCount)} visible
              <span className="text-muted-foreground"> · {formatCount(requester.hiddenFileCount)} hidden</span>
            </dd>
          </div>
        </dl>
        <div>
          <p className="text-xs text-muted-foreground">Permissions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {requester.permissions.length === 0 ? (
              <span className="text-xs text-muted-foreground">No permissions in this session.</span>
            ) : (
              requester.permissions.map((permission) => (
                <Badge key={permission} tone="outline">
                  {permission}
                </Badge>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
