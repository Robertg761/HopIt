'use client'

import * as React from 'react'
import { KeyRound, OctagonAlert } from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import {
  updateCodebaseKeyRotation,
  type KeyGrantStatusResponse,
  type UpdateKeyRotationInput,
} from '@/lib/collaboration'

import { CardNote, MonoId, RelativeTime, errorText } from './shared'

type RotationState = UpdateKeyRotationInput['rotationState']

const NEXT_STATE: Record<string, { state: RotationState; label: string }> = {
  stable: { state: 'planned', label: 'Plan rotation' },
  planned: { state: 'rotating', label: 'Start rotating' },
  rotating: { state: 'wrapped', label: 'Mark wrapped' },
  wrapped: { state: 'stable', label: 'Mark stable' },
  blocked: { state: 'planned', label: 'Resume as planned' },
}

function rotationTone(state: string | null): BadgeTone {
  if (state === 'stable') return 'hop'
  if (state === 'planned' || state === 'rotating' || state === 'wrapped') return 'amber'
  if (state === 'blocked') return 'danger'
  return 'outline'
}

export function KeyGrantsCard({
  response,
  loading,
  codebaseId,
  canManage,
  onKeys,
}: {
  response: KeyGrantStatusResponse | null
  loading: boolean
  codebaseId: string
  canManage: boolean
  onKeys: (response: KeyGrantStatusResponse) => void
}) {
  const { toast } = useToast()
  const [busy, setBusy] = React.useState(false)
  const [confirmBlocked, setConfirmBlocked] = React.useState(false)

  const errorCode = response?.error?.code
  const backendUnavailable =
    errorCode === 'd1_required' || errorCode === 'cloud_backend_unavailable' || errorCode?.startsWith('http_5') === true

  async function setRotation(rotationState: RotationState) {
    setBusy(true)
    try {
      const result = await updateCodebaseKeyRotation({ codebaseId, rotationState })
      if (result.ok) {
        onKeys(result)
        toast({ title: 'Rotation state updated', description: `Keyring is now ${rotationState}.` })
      } else {
        toast({
          title: 'Could not update rotation state',
          description: errorText(result.error, 'The rotation request failed.'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not update rotation state',
        description: error instanceof Error ? error.message : 'The rotation request failed.',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
      setConfirmBlocked(false)
    }
  }

  const keyring = response?.codebaseKeyring ?? null
  const rotationState = keyring?.rotationState ?? null
  const next = rotationState ? NEXT_STATE[rotationState] : NEXT_STATE.stable
  const activeWrapped = response?.wrappedKeys.filter((key) => key.status === 'active').length ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Key grants</CardTitle>
        <CardDescription>End-to-end encryption keyring, devices, and wrapped keys.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : backendUnavailable || !response ? (
          <CardNote>Key management needs the hosted D1 backend.</CardNote>
        ) : !response.ok ? (
          <CardNote>{errorText(response.error, 'Key grant status unavailable.')}</CardNote>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={rotationTone(rotationState)}>
                <KeyRound /> rotation: {rotationState ?? 'unknown'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {response.wrappedKeys.length} wrapped key{response.wrappedKeys.length === 1 ? '' : 's'}
                {response.wrappedKeys.length > 0 ? ` · ${activeWrapped} active` : ''}
              </span>
            </div>

            {keyring ? (
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                {(
                  [
                    ['Repo content key', keyring.repoContentKeyId],
                    ['Owner private key', keyring.ownerPrivateKeyId],
                    ['Git internals key', keyring.gitInternalsKeyId],
                    ['Default secret key', keyring.defaultSecretKeyId],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5">
                      <MonoId value={value} />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <CardNote>No codebase keyring has been provisioned yet.</CardNote>
            )}

            {response.devices.length > 0 ? (
              <div>
                <p className="text-xs text-muted-foreground">Devices</p>
                <div className="mt-1 space-y-1">
                  {response.devices.map((device) => (
                    <div
                      key={device.deviceId}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {device.displayName ?? <MonoId value={device.deviceId} />}
                      </span>
                      {device.platform ? <Badge tone="outline">{device.platform}</Badge> : null}
                      <Badge tone={device.status === 'revoked' ? 'danger' : device.status === 'trusted' ? 'hop' : 'neutral'}>
                        {device.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        seen <RelativeTime value={device.lastSeenAt} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {response.userKeyrings.length > 0 ? (
              <div>
                <p className="text-xs text-muted-foreground">User keyrings</p>
                <div className="mt-1 space-y-1">
                  {response.userKeyrings.map((ring) => (
                    <div key={ring.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50">
                      <MonoId value={ring.userId} className="min-w-0 flex-1" />
                      <Badge tone={ring.recoveryConfigured ? 'hop' : 'outline'}>
                        {ring.recoveryConfigured ? 'recovery configured' : 'no recovery'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">v{ring.currentVersion} · {ring.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {keyring ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canManage || busy}
                  title={!canManage ? 'Only the codebase owner can change rotation state.' : undefined}
                  onClick={() => void setRotation(next.state)}
                >
                  {busy ? 'Updating…' : next.label}
                </Button>
                {rotationState !== 'blocked' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={!canManage || busy}
                    title={!canManage ? 'Only the codebase owner can change rotation state.' : undefined}
                    onClick={() => setConfirmBlocked(true)}
                  >
                    <OctagonAlert className="size-4" /> Mark blocked
                  </Button>
                ) : null}
                {!canManage ? (
                  <p className="w-full text-xs text-muted-foreground">
                    Only the codebase owner can change rotation state.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <Dialog
        open={confirmBlocked}
        onOpenChange={setConfirmBlocked}
        title="Mark rotation blocked"
        description="Blocked halts the key rotation flow until it is manually resumed."
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmBlocked(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void setRotation('blocked')}>
              {busy ? 'Updating…' : 'Mark blocked'}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Mark this codebase keyring as <span className="font-medium">blocked</span>? Sync of wrapped keys pauses
          until rotation is resumed.
        </p>
      </Dialog>
    </Card>
  )
}
