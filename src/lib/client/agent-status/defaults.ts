import type { AgentStatusSnapshot } from '@hopit/core'

import { offlineRequester } from './mappers'

export function offlineAgentStatus(reason = 'Start the local HopIt agent status server.'): AgentStatusSnapshot {
  return {
    id: 'local-hopit-agent',
    state: 'offline',
    healthLabel: 'Offline',
    codebaseId: null,
    managedWorkspacePath: 'Agent not connected',
    codebaseName: 'No codebase',
    activeChangeSetId: 'No active change set',
    mainId: 'No Main state',
    cloudRevision: 'Unavailable',
    mainRevision: 'Unavailable',
    fileCount: 0,
    hiddenFileCount: 0,
    pendingWrites: 0,
    failedWrites: 0,
    acknowledgedWrites: 0,
    lastSync: 'Unavailable',
    lastAck: 'Unavailable',
    cacheState: 'offline',
    privateScope: 'none',
    privateScopePath: '.private/',
    visibility: 'Unavailable',
    reviewState: 'Unavailable',
    mergeState: 'Unavailable',
    conflictState: 'Unavailable',
    remoteUpdateState: 'Unavailable',
    remotePullState: 'Unavailable',
    remotePullEnabled: false,
    remotePullMode: 'Disabled',
    remotePullCadence: 'No remote pull',
    workspaceHydrationState: 'Unavailable',
    workspaceMaterializedRevision: null,
    workspaceIndexPath: null,
    remoteBehindByRevisions: null,
    commandsAvailable: false,
    backend: 'unknown',
    requester: offlineRequester(),
    members: [],
    files: [],
    events: [
      {
        id: 'agent-offline',
        label: 'agent:offline',
        detail: reason,
        when: 'now',
        tone: 'blocked',
      },
    ],
    rawUpdatedAt: null,
    unavailableReason: reason,
  }
}

