// @vitest-environment jsdom

// GR-D2 (decisions §7: "rotate, don't redact"). Round-trip: a `secret.suspected`
// event lands as a real notification row (packages/backend-d1/src/graph.js
// `appendEvent`), and this card is where the owner sees "possible secret in
// <path>" with rotation guidance and dismisses it per finding ("mark read").
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { NotificationItem, NotificationsResponse } from '@/lib/collaboration'
import { NotificationsCard } from './notifications-card'

const fetchNotifications = vi.fn<(codebaseId: string) => Promise<NotificationsResponse>>()
const markNotificationRead = vi.fn<(input: { codebaseId: string; notificationId: string }) => Promise<NotificationsResponse>>()

vi.mock('@/lib/collaboration', () => ({
  fetchNotifications: (codebaseId: string) => fetchNotifications(codebaseId),
  markNotificationRead: (input: { codebaseId: string; notificationId: string }) => markNotificationRead(input),
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

function makeSecretNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif_1',
    codebaseId: 'codebase-1',
    recipientUserId: null,
    kind: 'secret.suspected',
    title: 'Possible secret in src/config/keys.js',
    body: "2 possible findings in src/config/keys.js. Rotate the credential -- don't rely on deleting or redacting the entry, it may already be compromised.",
    href: '/codebases/codebase-1/activity?path=src%2Fconfig%2Fkeys.js',
    readAt: null,
    createdAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  }
}

describe('NotificationsCard', () => {
  it('surfaces a secret.suspected finding with rotation guidance within one poll cycle', async () => {
    fetchNotifications.mockResolvedValue({ ok: true, codebaseId: 'codebase-1', notifications: [makeSecretNotification()] })

    render(<NotificationsCard codebaseId="codebase-1" />)

    expect(await screen.findByText('Possible secret in src/config/keys.js')).toBeInTheDocument()
    expect(screen.getByText(/rotate the credential/i)).toBeInTheDocument()
    expect(screen.getByText("Rotate, don't redact")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Possible secret in src\/config\/keys\.js/ })).toHaveAttribute(
      'href',
      '/codebases/codebase-1/activity?path=src%2Fconfig%2Fkeys.js',
    )
  })

  it('dismisses a secret finding per-notification via mark read', async () => {
    fetchNotifications.mockResolvedValue({ ok: true, codebaseId: 'codebase-1', notifications: [makeSecretNotification()] })
    markNotificationRead.mockResolvedValue({
      ok: true,
      codebaseId: 'codebase-1',
      notifications: [makeSecretNotification({ readAt: '2026-07-24T10:05:00.000Z' })],
    })

    render(<NotificationsCard codebaseId="codebase-1" />)
    await screen.findByText('Possible secret in src/config/keys.js')

    fireEvent.click(screen.getByRole('button', { name: /mark read/i }))

    await waitFor(() => {
      expect(markNotificationRead).toHaveBeenCalledWith({ codebaseId: 'codebase-1', notificationId: 'notif_1' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /mark read/i })).not.toBeInTheDocument()
    })
  })

  it('does not badge an ordinary notification as a secret finding', async () => {
    fetchNotifications.mockResolvedValue({
      ok: true,
      codebaseId: 'codebase-1',
      notifications: [makeSecretNotification({ kind: 'review.approved', title: 'Change set approved', body: 'owner approved it.' })],
    })

    render(<NotificationsCard codebaseId="codebase-1" />)
    await screen.findByText('Change set approved')

    expect(screen.queryByText("Rotate, don't redact")).not.toBeInTheDocument()
  })
})
