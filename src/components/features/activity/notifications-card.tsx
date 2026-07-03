'use client'

import * as React from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/ui/status-dot'
import { useToast } from '@/hooks/use-toast'
import {
  fetchNotifications,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/collaboration'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'
import { cn } from '@/lib/utils'
import { humanizeApiError } from '@/lib/client/errors'

/** Hosted-D1-only notifications inbox with per-row mark-read. */
export function NotificationsCard({ codebaseId }: { codebaseId: string }) {
  const { toast } = useToast()
  const [notifications, setNotifications] = React.useState<NotificationItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [unavailable, setUnavailable] = React.useState(false)
  const [markingId, setMarkingId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setUnavailable(false)

    fetchNotifications(codebaseId)
      .then((response) => {
        if (cancelled) return
        if (response.ok) {
          setNotifications(response.notifications)
        } else {
          setNotifications([])
          setUnavailable(true)
        }
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [codebaseId])

  const markRead = async (notificationId: string) => {
    setMarkingId(notificationId)
    try {
      const response = await markNotificationRead({ codebaseId, notificationId })
      if (response.ok) {
        setNotifications(response.notifications)
      } else {
        toast({
          title: 'Could not mark as read',
          description: humanizeApiError(response.error?.message) || 'The notification service rejected the update.',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Could not mark as read',
        description: error instanceof Error ? error.message : 'Request failed.',
        variant: 'destructive',
      })
    } finally {
      setMarkingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : unavailable ? (
          <p className="text-xs text-muted-foreground">
            Notifications need the hosted D1 backend.
          </p>
        ) : notifications.length === 0 ? (
          <p className="text-xs text-muted-foreground">No notifications yet.</p>
        ) : (
          <ul className="space-y-1">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                marking={markingId === notification.id}
                markDisabled={markingId !== null}
                onMarkRead={() => void markRead(notification.id)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function NotificationRow({
  notification,
  marking,
  markDisabled,
  onMarkRead,
}: {
  notification: NotificationItem
  marking: boolean
  markDisabled: boolean
  onMarkRead: () => void
}) {
  const unread = notification.readAt === null
  const createdRelative = formatRelativeTime(notification.createdAt)
  const createdAbsolute = formatAbsoluteTime(notification.createdAt)

  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50',
        unread && 'bg-muted/40',
      )}
    >
      <StatusDot tone={unread ? 'iris' : 'neutral'} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm',
            unread ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {notification.href ? (
            <Link
              href={notification.href}
              className="rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {notification.title}
            </Link>
          ) : (
            notification.title
          )}
        </p>
        {notification.body.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">{notification.body}</p>
        ) : null}
      </div>
      <span
        className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground"
        title={createdAbsolute.length > 0 ? createdAbsolute : undefined}
      >
        {createdRelative}
      </span>
      {unread ? (
        <Button variant="ghost" size="sm" disabled={markDisabled} onClick={onMarkRead}>
          {marking ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />}
          Mark read
        </Button>
      ) : null}
    </li>
  )
}
