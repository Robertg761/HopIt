'use client'

import * as React from 'react'
import { MoreHorizontal, PauseCircle, UserX } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import {
  removeCodebaseMember,
  suspendCodebaseMember,
  type CodebaseMember,
  type MembersResponse,
} from '@/lib/collaboration'

import { CardNote, RelativeTime, RoleBadge, errorText } from './shared'

export function MembersCard({
  response,
  loading,
  codebaseId,
  onMembers,
}: {
  response: MembersResponse | null
  loading: boolean
  codebaseId: string
  onMembers: (response: MembersResponse) => void
}) {
  const { toast } = useToast()
  const [removeTarget, setRemoveTarget] = React.useState<CodebaseMember | null>(null)
  const [busyUserId, setBusyUserId] = React.useState<string | null>(null)

  const capabilities = response?.capabilities
  const canSuspend = capabilities?.suspend.enabled === true
  const canRemove = capabilities?.remove.enabled === true
  const showRowMenu = canSuspend || canRemove

  async function mutate(action: 'suspend' | 'remove', member: CodebaseMember) {
    setBusyUserId(member.userId)
    try {
      const call = action === 'suspend' ? suspendCodebaseMember : removeCodebaseMember
      const result = await call({ codebaseId, userId: member.userId })
      if (result.ok) {
        onMembers(result)
        toast({
          title: action === 'suspend' ? 'Member suspended' : 'Member removed',
          description: `${member.name} ${action === 'suspend' ? 'was suspended.' : 'no longer has access.'}`,
        })
      } else {
        toast({
          title: action === 'suspend' ? 'Could not suspend member' : 'Could not remove member',
          description: errorText(result.error, 'The request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Member update failed',
        description: error instanceof Error ? error.message : 'The request failed.',
        variant: 'destructive',
      })
    } finally {
      setBusyUserId(null)
      setRemoveTarget(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>Everyone with access to this codebase.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !response || response.members.length === 0 ? (
          <CardNote>
            {response?.unavailableReason ??
              (response && !response.ok
                ? errorText(response.error, 'Member list unavailable.')
                : 'No members yet. Invite someone below.')}
          </CardNote>
        ) : (
          response.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50 focus-within:bg-muted/50"
            >
              <MemberAvatar member={member} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{member.name}</p>
                {member.email ? (
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {member.status === 'suspended' ? <Badge tone="amber">suspended</Badge> : null}
                <RoleBadge role={member.role} />
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  joined <RelativeTime value={member.joinedAt} />
                </span>
                {showRowMenu ? (
                  busyUserId === member.userId ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${member.name}`}
                          className="text-muted-foreground"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={!canSuspend || member.status === 'suspended'}
                          onSelect={() => void mutate('suspend', member)}
                        >
                          <PauseCircle /> Suspend
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={!canRemove}
                          onSelect={() => setRemoveTarget(member)}
                        >
                          <UserX /> Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                ) : null}
              </div>
            </div>
          ))
        )}
      </CardContent>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title="Remove member"
        description="They immediately lose access to this codebase."
        footer={
          <>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyUserId !== null}
              onClick={() => {
                if (removeTarget) void mutate('remove', removeTarget)
              }}
            >
              {busyUserId !== null ? 'Removing…' : 'Remove member'}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Remove <span className="font-medium">{removeTarget?.name}</span>
          {removeTarget?.email ? (
            <span className="text-muted-foreground"> ({removeTarget.email})</span>
          ) : null}{' '}
          from this codebase?
        </p>
      </Dialog>
    </Card>
  )
}

function MemberAvatar({ member }: { member: CodebaseMember }) {
  if (member.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt=""
        className="size-8 shrink-0 rounded-full border border-border object-cover"
      />
    )
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {member.name.slice(0, 1).toUpperCase()}
    </span>
  )
}
