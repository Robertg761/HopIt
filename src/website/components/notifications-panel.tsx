'use client'

import * as React from 'react'
import {
  Bell,
  CheckCircle2,
  Loader2,
  RefreshCcw,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  fetchNotifications,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/collaboration'
import { cn } from '@/lib/utils'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'

type NotificationsPanelProps = {
  status: AgentStatusSnapshot
}

export function NotificationsPanel({ status }: NotificationsPanelProps) {
  const [notifications, setNotifications] = React.useState<NotificationItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [markingId, setMarkingId] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  const codebaseId = status.codebaseId
  const canMarkRead = Boolean(status.requester.id)

  const loadNotifications = React.useCallback(async () => {
    if (!codebaseId) {
      setNotifications([])
      return
    }

    setLoading(true)
    setMessage(null)
    try {
      const result = await fetchNotifications(codebaseId)
      setNotifications(result.notifications)
      if (!result.ok) setMessage(result.error?.message ?? 'Notifications failed to load.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Notifications failed to load.')
    } finally {
      setLoading(false)
    }
  }, [codebaseId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadNotifications()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [loadNotifications])

  async function markRead(notification: NotificationItem) {
    if (!codebaseId || !canMarkRead || notification.readAt) return

    setMarkingId(notification.id)
    setMessage(null)
    try {
      const result = await markNotificationRead({
        codebaseId,
        notificationId: notification.id,
      })
      setNotifications(result.notifications)
      if (!result.ok) setMessage(result.error?.message ?? 'Notification update failed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Notification update failed.')
    } finally {
      setMarkingId(null)
    }
  }

  const unreadCount = notifications.filter((notification) => !notification.readAt).length

  return (
    <section className="panel-surface overflow-hidden rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-hop/10 text-hop">
              <Bell className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Notifications</h2>
              <p className="truncate text-xs text-muted-foreground">
                {codebaseId ?? 'No codebase'} - review decisions, releases, and collaboration signals
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {message ? <span className="line-clamp-1 text-[11px] text-muted-foreground">{message}</span> : null}
          <span className={cn(
            'rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset',
            unreadCount > 0
              ? 'bg-hop/10 text-hop ring-hop/20'
              : 'bg-muted text-muted-foreground ring-border/60',
          )}>
            {unreadCount} unread
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || !codebaseId}
            className="h-8 rounded-lg text-xs"
            onClick={() => void loadNotifications()}
          >
            <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {notifications.length > 0 ? (
        <ol className="grid gap-2 p-4 md:grid-cols-2 xl:grid-cols-3">
          {notifications.map((notification) => {
            const isMarking = markingId === notification.id
            return (
              <li key={notification.id} className="rounded-lg border border-border/60 bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm font-semibold">{notification.title}</p>
                    <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{notification.body}</p>
                  </div>
                  <span className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ring-1 ring-inset',
                    notification.readAt
                      ? 'bg-muted text-muted-foreground ring-border/60'
                      : 'bg-hop/10 text-hop ring-hop/20',
                  )}>
                    {notification.readAt ? 'read' : 'new'}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
                    {notification.kind} - {formatDate(notification.createdAt)}
                  </span>
                  <div className="flex shrink-0 gap-1.5">
                    {notification.href ? (
                      <Button asChild type="button" size="sm" variant="outline" className="h-7 rounded-md px-2 text-[11px]">
                        <a href={notification.href}>Open</a>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!canMarkRead || Boolean(notification.readAt) || isMarking}
                      className="h-7 rounded-md px-2 text-[11px]"
                      onClick={() => void markRead(notification)}
                    >
                      {isMarking ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                      Read
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="p-6 text-center">
          <p className="text-sm font-medium">No notifications yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Review decisions, inline review activity, and release assets will appear here.
          </p>
        </div>
      )}
    </section>
  )
}

function formatDate(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}
