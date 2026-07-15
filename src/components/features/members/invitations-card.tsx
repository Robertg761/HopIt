'use client'

import * as React from 'react'
import { ChevronDown, ChevronRight, Copy, Mail } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import {
  acceptInvitation,
  createInvitation,
  revokeInvitation,
  type InvitationsResponse,
  type PendingInvitation,
} from '@/lib/collaboration'

import { CardNote, RelativeTime, RoleBadge, errorText } from './shared'

export function InvitationsCard({
  response,
  loading,
  codebaseId,
  onInvitations,
  refresh,
}: {
  response: InvitationsResponse | null
  loading: boolean
  codebaseId: string
  onInvitations: (response: InvitationsResponse) => void
  refresh: () => Promise<void>
}) {
  const { toast } = useToast()
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<PendingInvitation['role']>('member')
  const [inviting, setInviting] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState<string | null>(null)
  const [acceptOpen, setAcceptOpen] = React.useState(false)
  const [acceptToken, setAcceptToken] = React.useState('')
  const [accepting, setAccepting] = React.useState(false)
  const [revokingId, setRevokingId] = React.useState<string | null>(null)

  const capabilities = response?.capabilities
  const createCapability = capabilities?.create
  const canRevoke = capabilities?.revoke.enabled === true

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault()
    if (!email.trim() || inviting) return
    setInviting(true)
    try {
      const result = await createInvitation({ codebaseId, email: email.trim(), role })
      if (result.ok) {
        onInvitations(result)
        setCreatedToken(result.createdInvitationToken ?? null)
        setEmail('')
        toast({ title: 'Invitation created', description: 'Share the token below with the invitee.' })
      } else {
        toast({
          title: 'Could not create invitation',
          description: errorText(result.error, 'The invitation request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not create invitation',
        description: error instanceof Error ? error.message : 'The invitation request failed.',
        variant: 'destructive',
      })
    } finally {
      setInviting(false)
    }
  }

  async function submitAccept(event: React.FormEvent) {
    event.preventDefault()
    if (!acceptToken.trim() || accepting) return
    setAccepting(true)
    try {
      const result = await acceptInvitation({ codebaseId, token: acceptToken.trim() })
      if (result.ok) {
        onInvitations(result)
        setAcceptToken('')
        toast({ title: 'Invitation accepted', description: 'You now have access to this codebase.' })
        await refresh()
      } else {
        toast({
          title: 'Could not accept invitation',
          description: errorText(result.error, 'The accept request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not accept invitation',
        description: error instanceof Error ? error.message : 'The accept request failed.',
        variant: 'destructive',
      })
    } finally {
      setAccepting(false)
    }
  }

  async function revoke(invitation: PendingInvitation) {
    setRevokingId(invitation.id)
    try {
      const result = await revokeInvitation({ codebaseId, invitationId: invitation.id })
      if (result.ok) {
        onInvitations(result)
        toast({ title: 'Invitation revoked', description: `${invitation.email} can no longer use it.` })
      } else {
        toast({
          title: 'Could not revoke invitation',
          description: errorText(result.error, 'The revoke request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not revoke invitation',
        description: error instanceof Error ? error.message : 'The revoke request failed.',
        variant: 'destructive',
      })
    } finally {
      setRevokingId(null)
    }
  }

  function copyToken(token: string) {
    navigator.clipboard
      .writeText(token)
      .then(() => toast({ title: 'Token copied', description: 'The invitation token is on your clipboard.' }))
      .catch(() =>
        toast({ title: 'Copy failed', description: 'Select the token and copy it manually.', variant: 'destructive' }),
      )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>Invite collaborators and manage pending invitations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {response && !response.ok && response.unavailableReason ? (
              <CardNote>{response.unavailableReason}</CardNote>
            ) : null}

            {response && response.pendingInvitations.length > 0 ? (
              <div className="space-y-1">
                {response.pendingInvitations.map((invitation) => (
                  <div
                    key={invitation.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{invitation.email}</span>
                    <RoleBadge role={invitation.role} />
                    <span className="text-xs text-muted-foreground">{invitation.status}</span>
                    <span className="text-xs text-muted-foreground">
                      created <RelativeTime value={invitation.createdAt} />
                      {invitation.expiresAt ? (
                        <>
                          {' · expires '}
                          <RelativeTime value={invitation.expiresAt} />
                        </>
                      ) : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={!canRevoke || revokingId === invitation.id}
                      title={!canRevoke ? capabilities?.revoke.reason : undefined}
                      onClick={() => void revoke(invitation)}
                    >
                      {revokingId === invitation.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </div>
                ))}
              </div>
            ) : response?.ok ? (
              <p className="text-xs text-muted-foreground">No pending invitations.</p>
            ) : null}

            <form onSubmit={submitInvite} className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <Field label="Email" htmlFor="invite-email" className="min-w-52 flex-1">
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="teammate@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={!createCapability?.enabled || inviting}
                />
              </Field>
              <Field label="Role" htmlFor="invite-role" className="w-36">
                <Select
                  id="invite-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as PendingInvitation['role'])}
                  disabled={!createCapability?.enabled || inviting}
                >
                  <option value="member">Member</option>
                  <option value="maintainer">Maintainer</option>
                  <option value="viewer">Viewer</option>
                </Select>
              </Field>
              <Button type="submit" disabled={!createCapability?.enabled || inviting || !email.trim()}>
                <Mail className="size-4" />
                {inviting ? 'Inviting…' : 'Invite'}
              </Button>
              {createCapability && !createCapability.enabled && createCapability.reason ? (
                <p className="w-full text-xs text-muted-foreground">{createCapability.reason}</p>
              ) : null}
            </form>

            {createdToken ? (
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">
                  Share this one-time token with the invitee. They redeem it under “Accept an invitation”.
                  It is only shown once.
                </p>
                <div className="flex items-center gap-2">
                  <Input readOnly value={createdToken} className="font-mono text-xs" aria-label="Invitation token" />
                  <Button variant="outline" size="icon" aria-label="Copy invitation token" onClick={() => copyToken(createdToken)}>
                    <Copy />
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setAcceptOpen((open) => !open)}
                className="flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-expanded={acceptOpen}
              >
                {acceptOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                Accept an invitation
              </button>
              {acceptOpen ? (
                <form onSubmit={submitAccept} className="mt-3 flex flex-wrap items-end gap-3">
                  <Field label="Invitation token" htmlFor="accept-token" className="min-w-52 flex-1">
                    <Input
                      id="accept-token"
                      placeholder="Paste the token you received"
                      value={acceptToken}
                      onChange={(event) => setAcceptToken(event.target.value)}
                      className="font-mono text-xs"
                      disabled={accepting}
                    />
                  </Field>
                  <Button type="submit" variant="secondary" disabled={accepting || !acceptToken.trim()}>
                    {accepting ? 'Accepting…' : 'Accept'}
                  </Button>
                </form>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
