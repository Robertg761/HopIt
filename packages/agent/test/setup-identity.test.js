import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  deriveRemotePushUrl,
  writeConnectedEnvFile,
} from '../src/commands/setup.js'
import { productionEnvTemplate } from '../src/commands/install.js'
import {
  filterVisibleGraphForRequester as filterFixtureGraph,
} from '../src/cloud/d1-graph-service.js'
import { parseOptions } from '../src/options.js'
import {
  filterVisibleGraphForRequester as filterBackendGraph,
} from '../../backend-d1/src/helpers/access.js'

test('connected setup derives a credential-free WebSocket events endpoint', () => {
  assert.equal(
    deriveRemotePushUrl('https://agent-api.example.test/hopit/'),
    'wss://agent-api.example.test/hopit/events',
  )
  assert.throws(
    () => deriveRemotePushUrl('http://agent-api.example.test'),
    /must use HTTPS/,
  )
  assert.throws(
    () => deriveRemotePushUrl('https://user:secret@agent-api.example.test'),
    /must not contain credentials/,
  )
  assert.throws(
    () => deriveRemotePushUrl('https://agent-api.example.test?token=secret'),
    /must not contain credentials, query parameters, or a fragment/,
  )
})

test('connected setup persists requester identity and enables pull and push handoff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-setup-identity-'))
  const envFilePath = path.join(root, 'config', 'production.env')
  const options = {
    'codebase-id': 'shared-project-123',
    'state-root': path.join(root, 'state'),
    'workspace-root': path.join(root, 'workspaces'),
    'workspace-index': path.join(root, 'state', 'workspaces.json'),
    'device-keys': path.join(root, 'state', 'keys', 'device.json'),
    'requester-id': 'user_collaborator',
    'session-id': 'session_collaborator_device',
    'remote-pull': true,
    'remote-push': true,
    'remote-push-url': 'wss://agent-api.example.test/events',
    'd1-api-base-url': 'https://agent-api.example.test',
  }
  const connection = {
    codebaseId: 'shared-project-123',
    requesterId: 'user_collaborator',
    sessionId: 'session_collaborator_device',
    sessionToken: 'hst_test_session_token',
    apiBaseUrl: 'https://agent-api.example.test',
    remotePushUrl: 'wss://agent-api.example.test/events',
    blobProvider: 'r2',
    blobBroker: true,
    blobPrefix: 'hopit-staging',
  }

  await writeConnectedEnvFile(envFilePath, options, connection)
  const content = await fs.readFile(envFilePath, 'utf8')
  assert.match(content, /^HOPIT_REQUESTER_ID=user_collaborator$/m)
  assert.match(content, /^HOPIT_SESSION_ID=session_collaborator_device$/m)
  assert.match(content, /^HOPIT_REMOTE_PULL=1$/m)
  assert.match(content, /^HOPIT_REMOTE_PUSH=1$/m)
  assert.match(content, /^HOPIT_REMOTE_PUSH_URL=wss:\/\/agent-api\.example\.test\/events$/m)
  assert.match(content, /^HOPIT_BLOB_PROVIDER=r2$/m)
  assert.match(content, /^HOPIT_BLOB_BROKER=1$/m)
  assert.match(content, /^HOPIT_BLOB_PREFIX=hopit-staging$/m)

  const template = productionEnvTemplate(options)
  assert.match(template, /^HOPIT_REQUESTER_ID=user_collaborator$/m)
  assert.match(template, /^HOPIT_REMOTE_PUSH=1$/m)
  assert.match(template, /^HOPIT_REMOTE_PUSH_URL=wss:\/\/agent-api\.example\.test\/events$/m)
})

test('runtime options restore requester identity and remote push from the connected env', () => {
  const keys = [
    'HOPIT_PROFILE',
    'HOPIT_REQUESTER_ID',
    'HOPIT_SESSION_ID',
    'HOPIT_REMOTE_PULL',
    'HOPIT_REMOTE_PUSH',
    'HOPIT_REMOTE_PUSH_URL',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.HOPIT_PROFILE = 'development'
    process.env.HOPIT_REQUESTER_ID = 'user_collaborator'
    process.env.HOPIT_SESSION_ID = 'session_collaborator_device'
    process.env.HOPIT_REMOTE_PULL = '1'
    process.env.HOPIT_REMOTE_PUSH = '1'
    process.env.HOPIT_REMOTE_PUSH_URL = 'wss://agent-api.example.test/events'

    const options = parseOptions([])
    assert.equal(options['requester-id'], 'user_collaborator')
    assert.equal(options['session-id'], 'session_collaborator_device')
    assert.equal(options['remote-pull'], true)
    assert.equal(options['remote-push'], true)
    assert.equal(options['remote-push-url'], 'wss://agent-api.example.test/events')
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('a session id without an authenticated requester identity fails visibility closed', () => {
  const graph = visibleTeamGraph()
  for (const filter of [filterFixtureGraph, filterBackendGraph]) {
    const visible = filter(graph, { sessionId: 'session_untrusted_only' })
    assert.deepEqual(Object.keys(visible.files), [])
    assert.equal(visible.visibilityContext.id, null)
    assert.equal(visible.visibilityContext.isOwner, false)
    assert.equal(visible.visibilityContext.role, 'guest')
  }
})

function visibleTeamGraph() {
  return {
    schemaVersion: 2,
    codebase: { id: 'identity-core', name: 'Identity Core', ownerId: 'user_owner' },
    main: { id: 'main', revision: 1 },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_identity',
      ownerId: 'user_owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'team-visible',
      effectiveVisibility: 'team-visible',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
    },
    owner: { id: 'user_owner' },
    collaborators: [{ id: 'user_collaborator', role: 'member' }],
    session: { id: 'session_owner', deviceName: 'Owner device' },
    visibility: { effective: 'team-visible' },
    revision: 1,
    files: {
      'README.md': { kind: 'file', content: 'shared', revision: 1 },
      '.private/notes.md': { kind: 'file', content: 'secret', revision: 1 },
    },
  }
}
