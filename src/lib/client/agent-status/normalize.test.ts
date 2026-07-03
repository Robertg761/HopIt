import { beforeEach, describe, expect, it, vi } from 'vitest'

import demoCloud from '../../../../packages/agent/fixtures/demo-cloud.json'
import { humanizeApiError } from '../errors'
import { mapAgentStatusResponse, offlineAgentStatus } from './index'

describe('mapAgentStatusResponse', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'))
  })

  it('normalizes a local agent status payload', () => {
    const status = mapAgentStatusResponse({
      capabilities: {
        backend: 'local-agent',
        commands: true,
      },
      status: {
        ok: true,
        generatedAt: '2026-07-03T11:59:30.000Z',
        codebaseId: 'hopit-local',
        codebaseName: 'HopIt Local',
        activeChangeSetId: 'cs_local',
        mainId: 'main',
        ownerId: 'user_owner',
        requesterId: 'user_owner',
        requesterSessionId: 'session_local',
        requesterRole: 'owner',
        visibleFileCount: 2,
        hiddenFileCount: 1,
        effectiveChangeSetVisibility: 'private',
        workspace: {
          path: '/tmp/hopit-local',
          hydration: {
            state: 'hydrated',
            lastMaterializedRevision: 11,
          },
          index: {
            path: '/tmp/hopit-local/.hopit/workspace-index.json',
          },
          files: {
            'README.md': {
              path: '/tmp/hopit-local/README.md',
              exists: true,
              hydrated: true,
              state: 'dirty',
              dirty: true,
              bytesOnDisk: 120,
            },
          },
        },
        cloud: {
          revision: 12,
          main: {
            revision: 10,
          },
          scopeCounts: {
            private: 1,
          },
        },
        journal: {
          pendingCount: 1,
          failedCount: 0,
          acknowledgedCount: 3,
        },
        sync: {
          state: 'syncing',
          lastSuccessfulAt: '2026-07-03T11:55:00.000Z',
          lastAcknowledgementAt: '2026-07-03T11:59:30.000Z',
        },
        refresh: {
          state: 'idle',
        },
        remotePull: {
          enabled: true,
          state: 'idle',
          intervalMs: 300000,
          cursor: {
            materializedRevision: 11,
            graphRevision: 12,
            behindByRevisions: 1,
          },
        },
        review: {
          state: 'open',
        },
        merge: {
          state: 'unmerged',
        },
        conflict: {
          state: 'none',
        },
        events: {
          recent: [
            {
              id: 'event-1',
              event: 'agent.sync.started',
              at: '2026-07-03T11:59:00.000Z',
              detail: {
                trigger: 'manual',
              },
            },
          ],
        },
      },
    })

    expect(status.backend).toBe('local-agent')
    expect(status.commandsAvailable).toBe(true)
    expect(status.state).toBe('syncing')
    expect(status.cacheState).toBe('syncing')
    expect(status.codebaseId).toBe('hopit-local')
    expect(status.cloudRevision).toBe('cloud-rev 12')
    expect(status.mainRevision).toBe('main-rev 10')
    expect(status.requester.role).toBe('owner')
    expect(status.requester.permissions).toContain('manage_members')
    expect(status.workspaceMaterializedRevision).toBe(11)
    expect(status.remoteBehindByRevisions).toBe(1)
    expect(status.remotePullCadence).toBe('5 min cooldown')
    expect(status.events[0]).toMatchObject({
      id: 'event-1',
      label: 'agent.sync.started',
      detail: 'Triggered by manual',
      tone: 'syncing',
    })
  })

  it('normalizes a hosted D1 status payload with graph data', () => {
    const access = {
      id: 'user_demo_owner',
      sessionId: 'session_demo_browser',
      role: 'owner',
      isOwner: true,
      isCollaborator: true,
      membershipSource: 'owner',
      permissions: ['read', 'write', 'review'],
      visibleFileCount: 3,
      hiddenFileCount: 1,
    }
    const status = mapAgentStatusResponse({
      capabilities: {
        backend: 'cloudflare-d1-graph',
        hosted: true,
        commands: false,
      },
      status: {
        ok: true,
        generatedAt: '2026-07-03T11:58:00.000Z',
        codebaseId: demoCloud.codebase.id,
        codebaseName: demoCloud.codebase.name,
        activeChangeSetId: demoCloud.selectedState.id,
        mainId: demoCloud.main.id,
        ownerId: demoCloud.codebase.ownerId,
        visibleFileCount: 3,
        hiddenFileCount: 1,
        effectiveChangeSetVisibility: demoCloud.selectedState.effectiveVisibility,
        access,
        workspace: {
          path: '/Users/demo/hopit-core',
          hydration: {
            state: 'cloud-only',
          },
          files: {
            'README.md': {
              state: 'hydrated',
              exists: true,
              hydrated: true,
            },
          },
        },
        cloud: {
          revision: demoCloud.revision,
          main: {
            revision: demoCloud.main.revision,
          },
          scopeCounts: {
            private: 1,
          },
        },
        journal: {
          pendingCount: 0,
          failedCount: 0,
          acknowledgedCount: 4,
        },
        review: {
          state: demoCloud.selectedState.reviewState,
        },
        merge: {
          state: demoCloud.selectedState.mergeState,
        },
        conflict: {
          state: demoCloud.selectedState.conflictState,
        },
      },
      cloud: {
        graph: {
          codebase: demoCloud.codebase,
          owner: {
            ...demoCloud.owner,
            displayName: 'Demo Owner',
            email: 'owner@example.com',
          },
          collaborators: demoCloud.collaborators,
          visibilityContext: access,
          files: demoCloud.files,
        },
        access,
      },
      events: {
        recent: [
          {
            id: 'remote-1',
            event: 'agent.remote_update.detected',
            at: '2026-07-03T11:57:00.000Z',
            detail: {
              changedPaths: ['README.md', 'package.json'],
            },
          },
        ],
        lastRemoteUpdate: {
          id: 'remote-1',
          event: 'agent.remote_update.detected',
          at: '2026-07-03T11:57:00.000Z',
        },
      },
    })

    expect(status.backend).toBe('d1')
    expect(status.commandsAvailable).toBe(false)
    expect(status.state).toBe('online')
    expect(status.remoteUpdateState).toBe('updated')
    expect(status.members.map((member) => member.id)).toEqual(['user_demo_owner', 'user_demo_collaborator'])
    expect(status.files).toHaveLength(4)
    expect(status.files.find((file) => file.path === 'README.md')).toMatchObject({
      name: 'README.md',
      scope: 'shared',
      contentPreviewTruncated: false,
      local: {
        hydrated: true,
        state: 'hydrated',
      },
    })
    expect(status.files.find((file) => file.path === '.private/agent-note.md')).toMatchObject({
      scope: 'owner-private',
      contentPreview: null,
    })
    expect(status.events[0]).toMatchObject({
      detail: '2 remote paths updated',
      tone: 'observed',
    })
  })

  it('uses offline fallbacks when the endpoint has no status payload', () => {
    const status = mapAgentStatusResponse({
      capabilities: {
        backend: 'd1',
        commands: true,
      },
      error: {
        message: 'Agent status endpoint returned 503.',
      },
    })

    expect(status).toMatchObject({
      state: 'offline',
      backend: 'd1',
      commandsAvailable: true,
      unavailableReason: 'Agent status endpoint returned 503.',
    })
    expect(status.events[0].detail).toBe('Agent status endpoint returned 503.')
  })
})

describe('offlineAgentStatus', () => {
  it('builds a render-safe empty snapshot', () => {
    const status = offlineAgentStatus()

    expect(status.requester.role).toBe('guest')
    expect(status.members).toEqual([])
    expect(status.files).toEqual([])
    expect(status.events[0].label).toBe('agent:offline')
  })
})

describe('humanizeApiError', () => {
  it.each([
    ['Clerk: browser_auth_required', 'Sign in with your HopIt account to load collaboration data.'],
    ['Unexpected token < in JSON', 'The server returned an unexpected response. It may require sign-in or still be starting up.'],
    ['No HopIt cloud backend is configured.', 'The hosted cloud backend is not available in this environment.'],
    ['Failed to fetch', 'Could not reach the server. Check your connection and try again.'],
    ['Internal Server Error', 'The server hit an internal error. Try again in a moment.'],
  ])('humanizes %s', (raw, expected) => {
    expect(humanizeApiError(raw)).toBe(expected)
  })
})
