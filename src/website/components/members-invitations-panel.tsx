'use client'

import * as React from 'react'
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  MailPlus,
  ShieldCheck,
  Copy,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  acceptInvitation,
  claimCodebaseOwner,
  createInvitation,
  fetchKeyGrantStatus,
  fetchMembers,
  fetchInvitations,
  removeCodebaseMember,
  revokeInvitation,
  suspendCodebaseMember,
  type CodebaseMember,
  type InvitationsResponse,
  type KeyGrantStatusResponse,
  type MembersResponse,
  type PendingInvitation,
} from '@/lib/collaboration'
import type { AgentMember, AgentStatusSnapshot } from '@/website/lib/agent-status'
import { cn } from '@/lib/utils'

type MembersInvitationsPanelProps = {
  status: AgentStatusSnapshot
  loading: boolean
  onRefreshStatus?: () => Promise<void>
}

const inviteRoles: PendingInvitation['role'][] = ['member', 'maintainer', 'viewer']

export function MembersInvitationsPanel({ status, loading, onRefreshStatus }: MembersInvitationsPanelProps) {
  const [members, setMembers] = React.useState<MembersResponse | null>(null)
  const [loadingMembers, setLoadingMembers] = React.useState(false)
  const [invitations, setInvitations] = React.useState<InvitationsResponse | null>(null)
  const [loadingInvites, setLoadingInvites] = React.useState(false)
  const [keyGrantStatus, setKeyGrantStatus] = React.useState<KeyGrantStatusResponse | null>(null)
  const [loadingKeyGrants, setLoadingKeyGrants] = React.useState(false)
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<PendingInvitation['role']>('member')
  const [acceptToken, setAcceptToken] = React.useState('')
  const [actionMessage, setActionMessage] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState<string | null>(null)

  const codebaseId = status.codebaseId
  const durableMembers = Array.isArray(members?.members) ? members.members : []
  const displayedMembers = durableMembers.length > 0 ? durableMembers : fallbackMembers(status.members)
  const canManageInvites = hasPermission(status, 'invite') || hasPermission(status, 'manage_members')
  const canManageMembers = hasPermission(status, 'manage_members')
  const inviteCapability = invitations?.capabilities.create
  const claimDisabledReason = codebaseId ? null : 'No codebase is selected.'
  const inviteDisabledReason = disabledReason({
    codebaseId,
    allowedByRole: canManageInvites,
    capability: inviteCapability,
    fallback: 'Invitation capabilities are loading.',
    roleReason: 'Current role cannot invite members.',
  })
  const acceptDisabledReason = codebaseId ? null : 'No codebase is selected.'

  const loadMembers = React.useCallback(async () => {
    if (!codebaseId) {
      setMembers(null)
      return
    }

    setLoadingMembers(true)
    try {
      setMembers(await fetchMembers(codebaseId))
    } catch (error) {
      setMembers({
        ok: false,
        codebaseId,
        capabilities: {
          backend: 'unavailable',
          list: { enabled: false, reason: 'Member request failed.' },
          claimOwner: { enabled: false, reason: 'Member request failed.' },
          suspend: { enabled: false, reason: 'Member request failed.' },
          remove: { enabled: false, reason: 'Member request failed.' },
        },
        members: [],
        error: {
          code: 'member_fetch_failed',
          message: error instanceof Error ? error.message : 'Member request failed.',
        },
      })
    } finally {
      setLoadingMembers(false)
    }
  }, [codebaseId])

  React.useEffect(() => {
    let cancelled = false

    async function loadMembershipAndInvitations() {
      if (!codebaseId) {
        setMembers(null)
        setInvitations(null)
        setKeyGrantStatus(null)
        return
      }

      setLoadingMembers(true)
      setLoadingInvites(true)
      setLoadingKeyGrants(true)
      try {
        const [nextMembers, nextInvitations, nextKeyGrantStatus] = await Promise.all([
          fetchMembers(codebaseId),
          fetchInvitations(codebaseId),
          fetchKeyGrantStatus(codebaseId),
        ])
        if (!cancelled) {
          setMembers(nextMembers)
          setInvitations(nextInvitations)
          setKeyGrantStatus(nextKeyGrantStatus)
        }
      } catch (error) {
        if (!cancelled) {
          setMembers({
            ok: false,
            codebaseId,
            capabilities: {
              backend: 'unavailable',
              list: { enabled: false, reason: 'Member request failed.' },
              claimOwner: { enabled: false, reason: 'Member request failed.' },
              suspend: { enabled: false, reason: 'Member request failed.' },
              remove: { enabled: false, reason: 'Member request failed.' },
            },
            members: [],
            error: {
              code: 'member_fetch_failed',
              message: error instanceof Error ? error.message : 'Member request failed.',
            },
          })
          setInvitations({
            ok: false,
            codebaseId,
            capabilities: {
              backend: 'unavailable',
              list: { enabled: false, reason: 'Invitation request failed.' },
              create: { enabled: false, reason: 'Invitation request failed.' },
              accept: { enabled: false, reason: 'Invitation request failed.' },
              revoke: { enabled: false, reason: 'Invitation request failed.' },
            },
            pendingInvitations: [],
            error: {
              code: 'invitation_fetch_failed',
              message: error instanceof Error ? error.message : 'Invitation request failed.',
            },
          })
          setKeyGrantStatus({
            ok: false,
            codebaseId,
            codebaseKeyring: null,
            members: [],
            devices: [],
            userKeyrings: [],
            wrappedKeys: [],
            error: {
              code: 'key_status_fetch_failed',
              message: error instanceof Error ? error.message : 'Key grant request failed.',
            },
          })
        }
      } finally {
        if (!cancelled) setLoadingMembers(false)
        if (!cancelled) setLoadingInvites(false)
        if (!cancelled) setLoadingKeyGrants(false)
      }
    }

    const timeout = window.setTimeout(() => {
      void loadMembershipAndInvitations()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [codebaseId])

  async function handleClaimOwner() {
    if (!codebaseId || claimDisabledReason) return

    setSubmitting('claim-owner')
    setActionMessage(null)
    const result = await claimCodebaseOwner({ codebaseId })
    setMembers(result)
    setActionMessage(result.ok ? 'Owner claim accepted.' : (result.error?.message ?? 'Owner claim failed.'))
    if (result.ok) {
      const nextInvitations = await fetchInvitations(codebaseId)
      setInvitations(nextInvitations)
      await onRefreshStatus?.()
    }
    setSubmitting(null)
  }

  async function handleInviteSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codebaseId || inviteDisabledReason || !inviteEmail.trim()) return

    setSubmitting('invite')
    setActionMessage(null)
    const result = await createInvitation({
      codebaseId,
      email: inviteEmail,
      role: inviteRole,
    })
    setInvitations(result)
    setActionMessage(
      result.ok
        ? 'Invitation created.'
        : (result.error?.message ?? 'Invitation failed.'),
    )
    if (result.ok) setInviteEmail('')
    setSubmitting(null)
  }

  async function handleAcceptSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codebaseId || acceptDisabledReason || !acceptToken.trim()) return

    setSubmitting('accept')
    setActionMessage(null)
    const result = await acceptInvitation({
      codebaseId,
      token: acceptToken,
    })
    setInvitations(result)
    setActionMessage(result.ok ? 'Invitation accepted.' : (result.error?.message ?? 'Invitation accept failed.'))
    if (result.ok) setAcceptToken('')
    if (result.ok) {
      await Promise.all([loadMembers(), onRefreshStatus?.()])
    }
    setSubmitting(null)
  }

  async function handleRevokeInvitation(invitationId: string) {
    if (!codebaseId) return

    setSubmitting(`revoke:${invitationId}`)
    setActionMessage(null)
    const result = await revokeInvitation({
      codebaseId,
      invitationId,
    })
    setInvitations(result)
    setActionMessage(result.ok ? 'Invitation revoked.' : (result.error?.message ?? 'Invitation revoke failed.'))
    setSubmitting(null)
  }

  async function handleSuspendMember(userId: string) {
    if (!codebaseId) return

    setSubmitting(`suspend:${userId}`)
    setActionMessage(null)
    const result = await suspendCodebaseMember({
      codebaseId,
      userId,
    })
    setMembers(result)
    setActionMessage(result.ok ? 'Member suspended.' : (result.error?.message ?? 'Member suspend failed.'))
    if (result.ok) await onRefreshStatus?.()
    setSubmitting(null)
  }

  async function handleRemoveMember(userId: string) {
    if (!codebaseId) return

    setSubmitting(`remove:${userId}`)
    setActionMessage(null)
    const result = await removeCodebaseMember({
      codebaseId,
      userId,
    })
    setMembers(result)
    setActionMessage(result.ok ? 'Member removed.' : (result.error?.message ?? 'Member remove failed.'))
    if (result.ok) await onRefreshStatus?.()
    setSubmitting(null)
  }

  return (
    <section className="panel-surface overflow-hidden rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-hop/10 text-hop">
              <Users className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Members</h2>
              <p className="truncate text-xs text-muted-foreground">
                {status.codebaseId ?? 'No codebase'} - {status.requester.role}
              </p>
            </div>
          </div>
        </div>
        <RoleSummary status={status} loading={loading} />
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.1fr)_minmax(280px,0.9fr)]">
        <ViewerCard
          status={status}
          loading={loading}
          disabledReason={claimDisabledReason}
          submitting={submitting === 'claim-owner'}
          onClaimOwner={handleClaimOwner}
        />
        <MembersList
          members={displayedMembers}
          loading={loading || loadingMembers}
          offline={status.state === 'offline'}
          canManage={canManageMembers && Boolean(members?.capabilities.suspend.enabled || members?.capabilities.remove.enabled)}
          currentUserId={status.requester.id}
          submitting={submitting}
          onSuspend={handleSuspendMember}
          onRemove={handleRemoveMember}
        />
        <div className="space-y-3">
          <InviteForm
            email={inviteEmail}
            role={inviteRole}
            disabledReason={inviteDisabledReason}
            submitting={submitting === 'invite'}
            onEmailChange={setInviteEmail}
            onRoleChange={setInviteRole}
            onSubmit={handleInviteSubmit}
          />
          <PendingInvitations
            invitations={invitations}
            loading={loadingInvites}
            actionMessage={actionMessage}
            createdInvitationToken={invitations?.createdInvitationToken ?? null}
            submitting={submitting}
            onRevoke={handleRevokeInvitation}
          />
          <AcceptInviteForm
            token={acceptToken}
            disabledReason={acceptDisabledReason}
            submitting={submitting === 'accept'}
            onTokenChange={setAcceptToken}
            onSubmit={handleAcceptSubmit}
          />
          <KeyGrantStatusPanel status={keyGrantStatus} loading={loadingKeyGrants} canManage={canManageMembers} />
        </div>
      </div>
    </section>
  )
}

function RoleSummary({ status, loading }: { status: AgentStatusSnapshot; loading: boolean }) {
  const permissions = status.requester.permissions

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <SummaryChip label="Role" value={loading ? '...' : status.requester.role} active={status.requester.role !== 'guest'} />
      <SummaryChip label="Members" value={loading ? '...' : status.members.length.toString()} active={status.members.length > 0} />
      <SummaryChip label="Invite" value={permissions.includes('invite') ? 'allowed' : 'blocked'} active={permissions.includes('invite')} />
      <SummaryChip label="Hidden" value={status.hiddenFileCount.toString()} active={status.hiddenFileCount === 0} />
    </div>
  )
}

function SummaryChip({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg px-3 py-2 border transition duration-200',
        active ? 'bg-primary/8 text-primary border-primary/20 shadow-sm' : 'bg-muted/40 text-muted-foreground border-border/60',
      )}
    >
      <p className="truncate text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs font-bold text-foreground">{value}</p>
    </div>
  )
}

function ViewerCard({
  status,
  loading,
  disabledReason,
  submitting,
  onClaimOwner,
}: {
  status: AgentStatusSnapshot
  loading: boolean
  disabledReason: string | null
  submitting: boolean
  onClaimOwner: () => void
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
        <ShieldCheck className="size-4 text-primary" />
        Current viewer
      </p>
      <div className="mt-3 rounded-xl bg-card p-3.5 border border-border/50 shadow-sm">
        <div className="flex items-center gap-3">
          <Avatar label={status.requester.id ?? 'guest'} />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-foreground">
              {loading ? 'Loading viewer' : (status.requester.id ?? 'Guest')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status.requester.membershipSource}
            </p>
          </div>
        </div>
        <dl className="mt-3.5 space-y-2 text-[11px]">
          <ViewerDatum label="Role" value={status.requester.role} />
          <ViewerDatum label="Session" value={status.requester.sessionId ?? 'Unavailable'} />
          <ViewerDatum label="Visible files" value={status.requester.visibleFileCount?.toString() ?? status.fileCount.toString()} />
          <ViewerDatum label="Hidden files" value={status.requester.hiddenFileCount?.toString() ?? status.hiddenFileCount.toString()} />
        </dl>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {status.requester.permissions.length > 0 ? (
          status.requester.permissions.map((permission) => (
            <span
              key={permission}
              className="rounded-md bg-card px-2 py-0.5 text-[9px] font-bold text-muted-foreground uppercase border border-border/60 shadow-sm"
            >
              {permission}
            </span>
          ))
        ) : (
          <span className="rounded-md bg-card px-2 py-0.5 text-[9px] font-bold text-muted-foreground uppercase border border-border/60 shadow-sm">
            no permissions
          </span>
        )}
      </div>
      {!status.requester.isOwner ? (
        <div className="mt-3.5 rounded-xl bg-card p-3 border border-border/50 shadow-sm">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(disabledReason) || submitting}
            className="w-full justify-start rounded-lg text-xs font-bold cursor-pointer"
            onClick={onClaimOwner}
          >
            <ShieldCheck className="size-3.5 text-primary" />
            {submitting ? 'Claiming owner' : 'Claim owner'}
          </Button>
          {disabledReason ? <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">{disabledReason}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function ViewerDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  )
}

function MembersList({
  members,
  loading,
  offline,
  canManage,
  currentUserId,
  submitting,
  onSuspend,
  onRemove,
}: {
  members: CodebaseMember[]
  loading: boolean
  offline: boolean
  canManage: boolean
  currentUserId: string | null
  submitting: string | null
  onSuspend: (userId: string) => void
  onRemove: (userId: string) => void
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <Users className="size-3.5 text-grape" />
          Codebase members
        </p>
        <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
          {loading ? '...' : members.length}
        </span>
      </div>

      {loading ? (
        <PanelNotice icon={Users} title="Loading members" detail="Reading member records." />
      ) : members.length > 0 ? (
        <ol className="max-h-[360px] space-y-2 overflow-auto p-3 scroll-thin">
          {members.map((member) => (
            <li key={member.id} className="rounded-lg bg-card p-3 ring-1 ring-border/50">
              <div className="flex items-start gap-3">
                <Avatar label={member.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{member.name}</p>
                    {member.isOwner ? (
                      <span className="rounded-md bg-hop/10 px-1.5 py-0.5 text-[10px] font-medium text-hop">
                        owner
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{member.id}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <MemberPill>{member.role}</MemberPill>
                    <MemberPill>{member.status}</MemberPill>
                    <MemberPill>{member.source}</MemberPill>
                  </div>
                </div>
                <MemberActions
                  member={member}
                  canManage={canManage}
                  currentUserId={currentUserId}
                  submitting={submitting}
                  onSuspend={onSuspend}
                  onRemove={onRemove}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <PanelNotice
          icon={offline ? XCircle : Users}
          title={offline ? 'Agent offline' : 'No members returned'}
          detail={
            offline
              ? 'Start the local agent or configure cloud status to read members.'
              : 'The current graph did not return owner or collaborator rows.'
          }
        />
      )}
    </div>
  )
}

function MemberActions({
  member,
  canManage,
  currentUserId,
  submitting,
  onSuspend,
  onRemove,
}: {
  member: CodebaseMember
  canManage: boolean
  currentUserId: string | null
  submitting: string | null
  onSuspend: (userId: string) => void
  onRemove: (userId: string) => void
}) {
  const mutable = canManage && !member.isOwner && member.userId !== currentUserId
  const suspending = submitting === `suspend:${member.userId}`
  const removing = submitting === `remove:${member.userId}`

  if (!mutable) return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {member.status === 'active' ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(submitting)}
          className="h-7 rounded-lg px-2 text-[11px]"
          onClick={() => onSuspend(member.userId)}
        >
          {suspending ? 'Suspending' : 'Suspend'}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={Boolean(submitting)}
        className="h-7 rounded-lg px-2 text-[11px] text-destructive hover:text-destructive"
        onClick={() => onRemove(member.userId)}
      >
        {removing ? 'Removing' : 'Remove'}
      </Button>
    </div>
  )
}

function InviteForm({
  email,
  role,
  disabledReason,
  submitting,
  onEmailChange,
  onRoleChange,
  onSubmit,
}: {
  email: string
  role: PendingInvitation['role']
  disabledReason: string | null
  submitting: boolean
  onEmailChange: (email: string) => void
  onRoleChange: (role: PendingInvitation['role']) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <MailPlus className="size-3.5 text-hop" />
        Create invitation
      </p>
      <div className="mt-3 grid gap-2">
        <input
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          disabled={Boolean(disabledReason) || submitting}
          type="email"
          placeholder="name@example.com"
          className="h-9 rounded-lg border border-border/60 bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <select
          value={role}
          onChange={(event) => onRoleChange(event.target.value as PendingInvitation['role'])}
          disabled={Boolean(disabledReason) || submitting}
          className="h-9 rounded-lg border border-border/60 bg-card px-3 text-sm outline-none transition focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {inviteRoles.map((nextRole) => (
            <option key={nextRole} value={nextRole}>
              {nextRole}
            </option>
          ))}
        </select>
        <Button
          type="submit"
          size="sm"
          disabled={Boolean(disabledReason) || !email.trim() || submitting}
          className="justify-start rounded-lg"
        >
          <UserPlus className="size-3.5" />
          {submitting ? 'Sending' : 'Send invite'}
        </Button>
      </div>
      {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
    </form>
  )
}

function PendingInvitations({
  invitations,
  loading,
  actionMessage,
  createdInvitationToken,
  submitting,
  onRevoke,
}: {
  invitations: InvitationsResponse | null
  loading: boolean
  actionMessage: string | null
  createdInvitationToken: string | null
  submitting: string | null
  onRevoke: (invitationId: string) => void
}) {
  const pendingInvitations = invitations?.pendingInvitations ?? []
  const canRevoke = Boolean(invitations?.capabilities.revoke.enabled)

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <KeyRound className="size-3.5 text-grape" />
          Pending invitations
        </p>
        <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
          {loading ? '...' : pendingInvitations.length}
        </span>
      </div>

      {actionMessage ? (
        <p className="mt-2 rounded-lg bg-card px-2.5 py-2 text-[11px] text-muted-foreground ring-1 ring-border/50">
          {actionMessage}
        </p>
      ) : null}

      {createdInvitationToken ? <CreatedInvitationToken token={createdInvitationToken} /> : null}

      {loading ? (
        <PanelNotice icon={KeyRound} title="Loading invitations" detail="Reading invitation capabilities." compact />
      ) : pendingInvitations.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {pendingInvitations.map((invitation) => (
            <li key={invitation.id} className="rounded-lg bg-card p-2.5 ring-1 ring-border/50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">{invitation.email}</p>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {invitation.role} - {invitation.status}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRevoke || Boolean(submitting)}
                  className="h-7 rounded-lg px-2 text-[11px]"
                  onClick={() => onRevoke(invitation.id)}
                >
                  {submitting === `revoke:${invitation.id}` ? 'Revoking' : 'Revoke'}
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <PanelNotice
          icon={AlertCircle}
          title={invitations?.ok ? 'No pending invitations' : 'Pending list unavailable'}
          detail={
            invitations?.ok
              ? 'No invitations are currently waiting.'
              : invitations?.unavailableReason ?? 'Invitation capabilities are not loaded.'
          }
          compact
        />
      )}
    </div>
  )
}

function CreatedInvitationToken({ token }: { token: string }) {
  const [copied, setCopied] = React.useState(false)

  async function copyToken() {
    await navigator.clipboard.writeText(token)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mt-2 rounded-lg bg-card p-2.5 ring-1 ring-border/50">
      <p className="text-[10.5px] font-medium text-muted-foreground">Invitation token</p>
      <div className="mt-1.5 flex min-w-0 items-center gap-2">
        <input
          value={token}
          readOnly
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-muted/30 px-2 font-mono text-[11px] outline-none"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 rounded-md px-2"
          onClick={copyToken}
        >
          <Copy className="size-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

function AcceptInviteForm({
  token,
  disabledReason,
  submitting,
  onTokenChange,
  onSubmit,
}: {
  token: string
  disabledReason: string | null
  submitting: boolean
  onTokenChange: (token: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <CheckCircle2 className="size-3.5 text-hop" />
        Accept invitation
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          disabled={Boolean(disabledReason) || submitting}
          placeholder="invite token"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border/60 bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={Boolean(disabledReason) || !token.trim() || submitting}
          className="rounded-lg"
        >
          Accept
        </Button>
      </div>
      {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
    </form>
  )
}

function KeyGrantStatusPanel({
  status,
  loading,
  canManage,
}: {
  status: KeyGrantStatusResponse | null
  loading: boolean
  canManage: boolean
}) {
  const trustedDevices = status?.devices.filter((device) => device.status === 'trusted').length ?? 0
  const activeWraps = status?.wrappedKeys.filter((wrap) => wrap.status === 'active').length ?? 0
  const configuredVaults = status?.userKeyrings.filter((keyring) => keyring.status === 'active').length ?? 0
  const codebaseKeyring = status?.codebaseKeyring

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <KeyRound className="size-3.5 text-hop" />
          Key grants
        </p>
        <span className={cn(
          'rounded-md px-1.5 py-0.5 text-[10px] ring-1 ring-inset',
          status?.ok
            ? 'bg-hop/10 text-hop ring-hop/20'
            : 'bg-muted text-muted-foreground ring-border/60',
        )}>
          {loading ? '...' : status?.ok ? 'ready' : 'limited'}
        </span>
      </div>

      {loading ? (
        <PanelNotice icon={KeyRound} title="Loading key grants" detail="Reading trusted-device metadata." compact />
      ) : status?.ok ? (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <KeyGrantMetric label="Devices" value={trustedDevices.toString()} active={trustedDevices > 0} />
            <KeyGrantMetric label="Vaults" value={configuredVaults.toString()} active={configuredVaults > 0} />
            <KeyGrantMetric label="Wraps" value={activeWraps.toString()} active={activeWraps > 0} />
          </div>
          <dl className="mt-3 space-y-2 text-[11px]">
            <KeyGrantDatum label="Repo key" value={codebaseKeyring?.repoContentKeyId ?? 'not configured'} />
            <KeyGrantDatum label="Private key" value={codebaseKeyring?.ownerPrivateKeyId ?? 'not configured'} />
            <KeyGrantDatum label="Rotation" value={codebaseKeyring?.rotationState ?? 'not started'} />
          </dl>
          {status.devices.length > 0 ? (
            <ol className="mt-3 max-h-40 space-y-1.5 overflow-auto scroll-thin">
              {status.devices.slice(0, 5).map((device) => (
                <li key={device.deviceId} className="rounded-lg bg-card px-2.5 py-2 ring-1 ring-border/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{device.displayName ?? device.deviceId}</p>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {device.userId} - {device.encryptionPublicKeyAlgorithm}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {device.status}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {!canManage ? (
            <p className="mt-2 text-[11px] text-muted-foreground">Key grant details require member-management permission.</p>
          ) : null}
        </>
      ) : (
        <PanelNotice
          icon={AlertCircle}
          title="Key grants unavailable"
          detail={status?.error?.message ?? 'Key grant status is not loaded.'}
          compact
        />
      )}
    </div>
  )
}

function KeyGrantMetric({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className={cn(
      'min-w-0 rounded-lg px-2 py-1.5 border',
      active ? 'bg-primary/8 text-primary border-primary/20' : 'bg-card text-muted-foreground border-border/60',
    )}>
      <p className="truncate text-[9px] font-bold uppercase text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs font-bold text-foreground">{value}</p>
    </div>
  )
}

function KeyGrantDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  )
}

function PanelNotice({
  icon: Icon,
  title,
  detail,
  compact = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string
  compact?: boolean
}) {
  return (
    <div className={cn('p-4 text-center', compact && 'px-2 py-3')}>
      <Icon className="mx-auto size-4 text-muted-foreground" />
      <p className="mt-2 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function Avatar({ label }: { label: string }) {
  const initials = label
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'U'

  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hop-gradient text-xs font-semibold text-white">
      {initials}
    </div>
  )
}

function MemberPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

function fallbackMembers(members: AgentMember[]): CodebaseMember[] {
  return members.map((member) => ({
    id: member.id,
    userId: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status === 'suspended' ? 'suspended' : 'active',
    source: member.source,
    isOwner: member.isOwner,
    joinedAt: member.joinedAt,
    avatarUrl: member.avatarUrl,
  }))
}

function hasPermission(status: AgentStatusSnapshot, permission: string) {
  return status.requester.permissions.includes(permission)
}

function disabledReason({
  codebaseId,
  allowedByRole,
  capability,
  fallback,
  roleReason,
}: {
  codebaseId: string | null
  allowedByRole: boolean
  capability: { enabled: boolean; reason?: string } | undefined
  fallback: string
  roleReason: string
}) {
  if (!codebaseId) return 'No codebase is selected.'
  if (!allowedByRole) return roleReason
  if (!capability) return fallback
  if (!capability.enabled) return capability.reason ?? fallback
  return null
}
