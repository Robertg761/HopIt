import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { createD1Backend, d1SchemaStatements } from '@hopit/backend-d1'
import {
  createDeviceKeyMaterial,
  publicDeviceKeyDescriptor,
  unwrapSymmetricKeyFromDevice,
} from '@hopit/core/crypto'
import { D1CloudGraphService } from '../src/cloud/d1-graph-service.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

test('agent can initialize, hydrate, sync, and report status through D1', async (t) => {
  const server = await startD1ApiServer(t)
  const state = await makeState()
  const args = [
    ...stateArgs(state),
    '--cloud-backend',
    'd1',
    '--codebase-id',
    'hopit-core',
    '--d1-api-base-url',
    server.baseUrl,
    '--d1-account-id',
    'account_test',
    '--d1-database-id',
    'database_test',
    '--d1-api-token',
    'token_test',
  ]

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nD1-backed edit.\n', 'utf8')
  await runCli('sync-once', args)

  const status = JSON.parse((await runCli('status', args)).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.cloud.service, 'cloudflare-d1-graph')
  assert.equal(status.cloud.path, 'd1:hopit-core')
  assert.equal(status.cloud.fileCount, 4)
  assert.equal(status.cloud.revision, 2)

  const events = await readNdjson(state.events)
  const acknowledgement = events.find((event) => event.event === 'cloud.acknowledged')
  assert.equal(acknowledgement.detail.storageMode, 'd1-file-mutation')
})

test('workspace discover lists account-visible D1 codebases with local readiness', async (t) => {
  const server = await startD1ApiServer(t)
  const state = await makeState()
  const baseArgs = [
    ...stateArgs(state),
    '--cloud-backend',
    'd1',
    '--d1-api-base-url',
    server.baseUrl,
    '--d1-account-id',
    'account_test',
    '--d1-database-id',
    'database_test',
    '--d1-api-token',
    'token_test',
  ]

  await runCli('init', [...baseArgs, '--codebase-id', 'hopit-core', '--force'])
  await runCli('hydrate', [...baseArgs, '--codebase-id', 'hopit-core'])
  const backend = createD1Backend({
    'codebase-id': 'beta-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize({
    schemaVersion: 2,
    codebase: {
      id: 'beta-core',
      name: 'Beta Core',
      ownerId: 'user_demo_owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: new Date().toISOString(),
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_beta_core_active',
      ownerId: 'user_demo_owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'private',
      effectiveVisibility: 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: 'user_demo_owner',
      name: 'Demo Owner',
    },
    collaborators: [],
    session: {
      id: 'session_beta_core',
      deviceName: 'test',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'private',
      effective: 'private',
    },
    revision: 1,
    files: {
      'README.md': {
        kind: 'file',
        content: 'beta',
        encoding: 'utf8',
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  })

  const discovered = JSON.parse((await runCli('workspace', [
    'discover',
    ...baseArgs,
    '--codebase-id',
    'hopit-core',
  ])).stdout)

  assert.equal(discovered.ok, true)
  assert.equal(discovered.cloud.discovery, 'account-codebases')
  assert.equal(discovered.codebases.length, 2)

  const alpha = discovered.codebases.find((codebase) => codebase.id === 'hopit-core')
  const beta = discovered.codebases.find((codebase) => codebase.id === 'beta-core')
  assert.equal(alpha.attached, true)
  assert.equal(alpha.remoteUpdate.state, 'ready')
  assert.equal(alpha.remoteUpdate.behindByRevisions, 0)
  assert.equal(alpha.workspace.hydration.state, 'materialized')
  assert.equal(beta.attached, false)
  assert.equal(beta.remoteUpdate.state, 'not-attached')
  assert.equal(beta.workspace.hydration.state, 'not_attached')
  assert.equal(beta.cloud.service, 'cloudflare-d1-graph')
})

test('D1 account bootstrap claims local-owner codebases for the verified owner', async (t) => {
  const server = await startD1ApiServer(t)
  const previousOwnerEmail = process.env.HOPIT_OWNER_EMAIL
  process.env.HOPIT_OWNER_EMAIL = 'owner@example.com'
  t.after(() => {
    if (previousOwnerEmail === undefined) delete process.env.HOPIT_OWNER_EMAIL
    else process.env.HOPIT_OWNER_EMAIL = previousOwnerEmail
  })

  const backend = createD1Backend({
    'codebase-id': 'bootstrap-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const owner = {
    userId: 'user_owner',
    primaryEmail: 'owner@example.com',
    displayName: 'Owner',
    currentAuthEmailVerified: true,
  }

  await backend.createCodebase({
    codebaseId: 'bootstrap-core',
    name: 'Bootstrap Core',
    actor: {},
  })

  const beforeBootstrap = await backend.listCodebases(owner)
  assert.equal(beforeBootstrap.length, 0)

  const bootstrap = await backend.bootstrapAccount(owner)
  assert.equal(bootstrap.ok, true)
  assert.deepEqual(bootstrap.claimed.map((row) => row.codebaseId), ['bootstrap-core'])
  assert.equal(bootstrap.failed.length, 0)

  const afterBootstrap = await backend.listCodebases(owner)
  assert.equal(afterBootstrap.length, 1)
  assert.equal(afterBootstrap[0].codebase.id, 'bootstrap-core')
  assert.equal(afterBootstrap[0].codebase.ownerId, 'user_owner')
  assert.equal(afterBootstrap[0].access.role, 'owner')

  const secondBootstrap = await backend.bootstrapAccount(owner)
  assert.equal(secondBootstrap.ok, true)
  assert.equal(secondBootstrap.claimed.length, 0)
})

test('D1 allocates distinct tenant-safe ids for the same common codebase name', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = createD1Backend({
    'codebase-id': 'allocation-test',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })

  const first = await backend.createCodebase({
    name: 'My Project',
    actor: { userId: 'user_account_one' },
  })
  const second = await backend.createCodebase({
    name: 'My Project',
    actor: { userId: 'user_account_two' },
  })

  assert.match(first.codebase.id, /^my-project-[0-9a-f-]{36}$/)
  assert.match(second.codebase.id, /^my-project-[0-9a-f-]{36}$/)
  assert.notEqual(first.codebase.id, second.codebase.id)
  assert.equal((await backend.readGraph(first.codebase.id)).codebase.ownerId, 'user_account_one')
  assert.equal((await backend.readGraph(second.codebase.id)).codebase.ownerId, 'user_account_two')
  assert.deepEqual(
    (await backend.listCodebases({ userId: 'user_account_one' })).map((head) => head.codebase.id),
    [first.codebase.id],
  )
  assert.deepEqual(
    (await backend.listCodebases({ userId: 'user_account_two' })).map((head) => head.codebase.id),
    [second.codebase.id],
  )
})

test('D1 backend supports members, invitations, and collaboration work items', async (t) => {
  const server = await startD1ApiServer(t)
  const previousOwnerEmail = process.env.HOPIT_OWNER_EMAIL
  process.env.HOPIT_OWNER_EMAIL = 'owner@example.com'
  t.after(() => {
    if (previousOwnerEmail === undefined) delete process.env.HOPIT_OWNER_EMAIL
    else process.env.HOPIT_OWNER_EMAIL = previousOwnerEmail
  })

  const backend = createD1Backend({
    'codebase-id': 'collab-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize({
    schemaVersion: 2,
    codebase: {
      id: 'collab-core',
      name: 'Collab Core',
      ownerId: 'local-owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: new Date().toISOString(),
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_collab_core_main',
      ownerId: 'local-owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'team-visible',
      effectiveVisibility: 'team-visible',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: 'local-owner',
      name: 'Local Owner',
    },
    collaborators: [],
    session: {
      id: 'session_test',
      deviceName: 'test',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'team-visible',
      effective: 'team-visible',
    },
    revision: 1,
    files: {
      'README.md': {
        kind: 'file',
        content: 'hello',
        encoding: 'utf8',
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  })

  const owner = {
    userId: 'user_owner',
    primaryEmail: 'owner@example.com',
    displayName: 'Owner',
    currentAuthEmailVerified: true,
  }
  await backend.claimCodebaseOwner({ codebaseId: 'collab-core', actor: owner })

  const issue = await backend.createWorkItem({
    type: 'issue',
    codebaseId: 'collab-core',
    title: 'Track D1 collaboration',
    priority: 'high',
    labels: ['d1', 'migration', 'd1'],
    actor: owner,
  })
  const discussion = await backend.createWorkItem({
    type: 'discussion',
    codebaseId: 'collab-core',
    title: 'Migration notes',
    body: 'D1 is the primary backend.',
    category: 'announcements',
    actor: owner,
  })
  const release = await backend.createWorkItem({
    type: 'release',
    codebaseId: 'collab-core',
    version: 'v1.0.0-d1',
    title: 'D1 migration',
    notes: 'First D1-backed collaboration release.',
    actor: owner,
  })
  const releaseAsset = await backend.createWorkItem({
    type: 'releaseAsset',
    codebaseId: 'collab-core',
    releaseId: release.id,
    name: 'hopit-d1-migration.tar.gz',
    kind: 'archive',
    url: 'https://example.com/hopit-d1-migration.tar.gz',
    checksum: 'sha256:test',
    size: 1024,
    actor: owner,
  })
  assert.equal(releaseAsset.releaseId, release.id)
  assert.equal(releaseAsset.kind, 'archive')
  const issueComment = await backend.createWorkItem({
    type: 'issueComment',
    codebaseId: 'collab-core',
    issueId: issue.id,
    body: 'This issue now has a durable comment.',
    actor: owner,
  })
  assert.equal(issueComment.issueId, issue.id)
  const discussionComment = await backend.createWorkItem({
    type: 'discussionComment',
    codebaseId: 'collab-core',
    discussionId: discussion.id,
    body: 'This discussion also has a durable comment.',
    actor: owner,
  })
  assert.equal(discussionComment.discussionId, discussion.id)
  const project = await backend.createWorkItem({
    type: 'project',
    codebaseId: 'collab-core',
    name: 'D1 migration board',
    description: 'Track the D1 migration follow-through.',
    actor: owner,
  })
  assert.equal(project.status, 'active')
  assert.deepEqual(project.columns.map((column) => column.id), ['todo', 'in-progress', 'done'])

  const projectItem = await backend.createWorkItem({
    type: 'projectItem',
    codebaseId: 'collab-core',
    projectId: project.id,
    item: { type: 'issue', id: issue.id },
    columnId: 'todo',
    actor: owner,
  })
  assert.equal(projectItem.item.id, issue.id)
  assert.equal(projectItem.columnId, 'todo')

  const movedProjectItem = await backend.updateWorkItem({
    action: 'moveProjectItem',
    codebaseId: 'collab-core',
    projectItemId: projectItem.id,
    columnId: 'in-progress',
    position: 10,
    actor: owner,
  })
  assert.equal(movedProjectItem.columnId, 'in-progress')
  assert.equal(movedProjectItem.position, 10)

  await assert.rejects(
    () => backend.createWorkItem({
      type: 'projectItem',
      codebaseId: 'collab-core',
      projectId: project.id,
      item: { type: 'discussion', id: 'dis_missing_other_codebase' },
      actor: owner,
    }),
    /Discussion dis_missing_other_codebase was not found in collab-core/,
  )

  const items = await backend.listWorkItems({ codebaseId: 'collab-core', actor: owner })
  assert.equal(items.issues.length, 1)
  assert.equal(items.issues[0].number, 1)
  assert.deepEqual(items.issues[0].labels, ['d1', 'migration'])
  assert.equal(items.issues[0].comments.length, 1)
  assert.equal(items.issues[0].comments[0].body, 'This issue now has a durable comment.')
  assert.equal(items.discussions.length, 1)
  assert.equal(items.discussions[0].comments.length, 1)
  assert.equal(items.discussions[0].comments[0].body, 'This discussion also has a durable comment.')
  assert.equal(items.releases.length, 1)
  assert.equal(items.releases[0].assets.length, 1)
  assert.equal(items.releases[0].assets[0].name, 'hopit-d1-migration.tar.gz')
  assert.equal(items.projects.length, 1)
  assert.equal(items.projects[0].items.length, 1)
  assert.equal(items.projects[0].items[0].columnId, 'in-progress')

  const reviewThread = await backend.createReviewThread({
    codebaseId: 'collab-core',
    changeSetId: 'cs_collab_core_main',
    filePath: 'README.md',
    lineNumber: 1,
    baseRevision: 'main-rev-1',
    headRevision: 'cloud-rev-1',
    lineFingerprint: 'hash:1:1',
    body: 'Anchor this line before merge.',
    actor: owner,
  })
  assert.equal(reviewThread.filePath, 'README.md')
  assert.equal(reviewThread.comments.length, 1)
  const threadComment = await backend.createReviewThreadComment({
    threadId: reviewThread.id,
    body: 'Follow-up on the anchored line.',
    actor: owner,
  })
  assert.equal(threadComment.threadId, reviewThread.id)
  const resolvedThread = await backend.resolveReviewThread({
    threadId: reviewThread.id,
    actor: owner,
  })
  assert.equal(resolvedThread.status, 'resolved')
  const reviewThreads = await backend.listReviewThreads({
    codebaseId: 'collab-core',
    changeSetId: 'cs_collab_core_main',
    actor: owner,
  })
  assert.equal(reviewThreads.length, 1)
  assert.equal(reviewThreads[0].comments.length, 2)

  const reviewDecision = await backend.createReviewDecision({
    codebaseId: 'collab-core',
    changeSetId: 'cs_collab_core_main',
    decision: 'approved',
    summary: 'Ready to merge after the D1-backed review loop.',
    actor: owner,
  })
  assert.equal(reviewDecision.decision, 'approved')
  assert.equal(reviewDecision.changeSetId, 'cs_collab_core_main')
  const reviewDecisions = await backend.listReviewDecisions({
    codebaseId: 'collab-core',
    changeSetId: 'cs_collab_core_main',
    actor: owner,
  })
  assert.equal(reviewDecisions.length, 1)
  assert.equal(reviewDecisions[0].summary, 'Ready to merge after the D1-backed review loop.')

  const notifications = await backend.listNotifications({ codebaseId: 'collab-core', actor: owner })
  assert.ok(notifications.length >= 4)
  assert.ok(notifications.some((notification) => notification.kind === 'review.approved'))
  const readNotification = await backend.markNotificationRead({
    codebaseId: 'collab-core',
    notificationId: notifications[0].id,
    actor: owner,
  })
  assert.equal(readNotification.id, notifications[0].id)
  assert.match(readNotification.readAt, /^\d{4}-\d{2}-\d{2}T/)

  await backend.ensureCodebaseKeyring({
    codebaseId: 'collab-core',
    repoContentKeyId: 'key_repo_collab',
    ownerPrivateKeyId: 'key_owner_private_collab',
    gitInternalsKeyId: 'key_git_collab',
    defaultSecretKeyId: 'key_secret_collab',
    actor: owner,
  })
  const rotation = await backend.updateCodebaseKeyringRotationState({
    codebaseId: 'collab-core',
    rotationState: 'planned',
    actor: owner,
  })
  assert.equal(rotation.rotationState, 'planned')

  const archivedProject = await backend.updateWorkItem({
    action: 'archiveProject',
    codebaseId: 'collab-core',
    projectId: project.id,
    actor: owner,
  })
  assert.equal(archivedProject.status, 'archived')
  assert.equal(issue.title, 'Track D1 collaboration')
  assert.equal(discussion.title, 'Migration notes')
  assert.equal(release.version, 'v1.0.0-d1')

  const invitation = await backend.createInvitation({
    codebaseId: 'collab-core',
    email: 'member@example.com',
    role: 'member',
    actor: owner,
  })
  assert.match(invitation.token, /^[A-Za-z0-9_-]+$/)

  const member = {
    userId: 'user_member',
    primaryEmail: 'member@example.com',
    displayName: 'Member',
    currentAuthEmailVerified: true,
  }
  await backend.acceptInvitation({ token: invitation.token, actor: member })
  const members = await backend.listMembers({ codebaseId: 'collab-core', status: 'active', actor: owner })
  assert.deepEqual(members.map((row) => row.userId).sort(), ['user_member', 'user_owner'])

  const memberRead = await backend.readTextFile({
    codebaseId: 'collab-core',
    path: 'README.md',
    actor: member,
  })
  assert.equal(memberRead.content, 'hello')
})

test('D1 backend supports scoped sessions and trusted device key metadata', async (t) => {
  const server = await startD1ApiServer(t)
  const state = await makeState()
  const args = [
    ...stateArgs(state),
    '--cloud-backend',
    'd1',
    '--codebase-id',
    'hopit-core',
    '--d1-api-base-url',
    server.baseUrl,
    '--d1-account-id',
    'account_test',
    '--d1-database-id',
    'database_test',
    '--d1-api-token',
    'token_test',
  ]

  await runCli('init', [...args, '--force'])

  const registered = JSON.parse((await runCli('session', [
    'register',
    ...args,
    '--session-id',
    'session_device_core',
    '--device-name',
    'D1 Test Device',
    '--capabilities',
    'read,write,sync,watch,admin',
  ])).stdout)
  assert.equal(registered.ok, true)
  assert.equal(registered.session.sessionId, 'session_device_core')
  assert.equal(registered.session.userId, 'user_demo_owner')
  assert.equal(registered.session.status, 'active')
  assert.match(registered.sessionToken, /^hst_/)

  const listed = JSON.parse((await runCli('session', ['list', ...args])).stdout)
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].sessionId, 'session_device_core')
  assert.equal(JSON.stringify(listed).includes(registered.sessionToken), false)

  const touched = JSON.parse((await runCli('session', [
    'touch',
    ...args,
    '--session-id',
    'session_device_core',
    '--session-token',
    registered.sessionToken,
  ])).stdout)
  assert.equal(touched.session.sessionId, 'session_device_core')
  assert.equal(touched.session.status, 'active')

  const keyring = JSON.parse((await runCli('keys', [
    'init-device',
    ...args,
    '--session-id',
    'session_device_core',
    '--device-name',
    'D1 Test Device',
    '--session-token',
    registered.sessionToken,
  ])).stdout)
  assert.equal(keyring.ok, true)
  assert.equal(keyring.cloudRegistration.registered, true)
  assert.equal(keyring.cloudRegistration.deviceKey.userId, 'user_demo_owner')
  assert.equal(keyring.cloudRegistration.deviceKey.status, 'trusted')
  assert.equal(keyring.cloudRegistration.userKeyring.status, 'active')
  assert.equal(keyring.cloudRegistration.userVaultWrap.status, 'active')
  assert.equal(JSON.stringify(keyring).includes(registered.sessionToken), false)
  assert.equal(JSON.stringify(keyring).includes('PRIVATE KEY'), false)
  assert.equal(JSON.stringify(keyring).includes('ciphertext'), false)

  const backend = createD1Backend({
    'codebase-id': 'hopit-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const devices = await backend.listDeviceKeys({ codebaseId: 'hopit-core' })
  assert.equal(devices.length, 1)
  assert.equal(devices[0].deviceId, keyring.keyring.deviceId)

  const wraps = await backend.listWrappedKeys({ codebaseId: 'hopit-core' })
  assert.equal(wraps.length, 1)
  assert.equal(wraps[0].recipientId, keyring.keyring.deviceId)
  const keyStatus = await backend.readKeyGrantStatus({
    codebaseId: 'hopit-core',
    actor: { userId: 'user_demo_owner' },
  })
  assert.equal(keyStatus.devices.length, 1)
  assert.equal(keyStatus.userKeyrings.length, 1)
  assert.equal(keyStatus.wrappedKeys.length, 1)
  assert.equal(Object.hasOwn(keyStatus.wrappedKeys[0], 'ciphertext'), false)

  const scopedBackend = createD1Backend({
    'codebase-id': 'hopit-core',
    'd1-api-base-url': server.baseUrl,
    'session-token': registered.sessionToken,
  })
  const scopedGraph = await scopedBackend.readGraph('hopit-core')
  assert.equal(scopedGraph.codebase.id, 'hopit-core')
  const scopedAccess = await scopedBackend.requireD1AgentAccess(
    'hopit-core',
    { sessionToken: registered.sessionToken },
    'write',
    { touch: true },
  )
  assert.equal(scopedAccess.userId, 'user_demo_owner')
  scopedGraph.revision += 1
  scopedGraph.main.revision = scopedGraph.revision
  scopedGraph.files['SESSION_ONLY.md'] = {
    kind: 'file',
    content: 'scoped session write',
    encoding: 'utf8',
    revision: scopedGraph.revision,
    updatedAt: new Date().toISOString(),
  }
  await scopedBackend.writeGraph(scopedGraph)
  const afterScopedWrite = await backend.readGraph('hopit-core')
  assert.equal(afterScopedWrite.files['SESSION_ONLY.md'].content, 'scoped session write')

  const readOnlySession = await backend.registerAgentSession({
    codebaseId: 'hopit-core',
    sessionId: 'session_read_only',
    deviceName: 'Read Only Device',
    capabilities: ['read'],
  })
  const readOnlyBackend = createD1Backend({
    'codebase-id': 'hopit-core',
    'd1-api-base-url': server.baseUrl,
    'session-token': readOnlySession.sessionToken,
  })
  assert.equal((await readOnlyBackend.readGraph('hopit-core')).codebase.id, 'hopit-core')
  await assert.rejects(
    () => readOnlyBackend.requireD1AgentAccess('hopit-core', { sessionToken: readOnlySession.sessionToken }, 'write'),
    /write capability/,
  )
  await assert.rejects(
    () => readOnlyBackend.writeGraph(scopedGraph),
    /write capability/,
  )

  const revoked = JSON.parse((await runCli('session', [
    'revoke',
    ...args,
    '--session-id',
    'session_device_core',
    '--session-token',
    registered.sessionToken,
  ])).stdout)
  assert.equal(revoked.session.status, 'revoked')
})

test('D1 assume-schema mode skips schema setup queries', async (t) => {
  const statements = []
  const server = await startD1ApiServer(t, { statements })
  for (const sql of d1SchemaStatements) {
    server.db.prepare(sql).run()
  }

  const backend = createD1Backend({
    'codebase-id': 'schema-skip',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_schema_skip',
    'd1-api-token': 'token_test',
    'assume-schema': true,
  })

  await backend.createCodebase({
    name: 'Schema Skip',
    codebaseId: 'schema-skip',
    actor: { userId: 'user_schema_skip' },
  })
  statements.length = 0

  const dashboard = await backend.readDashboard({
    codebaseId: 'schema-skip',
    requesterUserId: 'user_schema_skip',
  })

  assert.equal(dashboard.cloud.exists, true)
  assert.equal(statements.some((sql) => /^\s*create\s+/i.test(sql)), false)
})

test('D1 device authorization exchanges a one-time code for a device-encrypted scoped session', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = createD1Backend({
    'codebase-id': 'device-auth-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({ codebaseId: 'device-auth-core' }))
  const device = createDeviceKeyMaterial({
    deviceId: 'dev_device_auth_test',
    deviceName: 'Authorization Test Device',
    platform: 'test-platform',
  })

  const created = await backend.createDeviceAuthorization({
    deviceKey: publicDeviceKeyDescriptor(device),
    requestFingerprint: 'fingerprint_test',
  })
  assert.match(created.deviceCode, /^hdc_/)
  assert.match(created.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal((await backend.pollDeviceAuthorization(created.deviceCode)).status, 'pending')
  const approvalView = await backend.readDeviceAuthorizationForApproval(created.userCode.toLowerCase())
  assert.equal(approvalView.device.id, device.deviceId)
  assert.equal(Object.hasOwn(approvalView.device, 'encryptionPublicKey'), false)

  const approved = await backend.approveDeviceAuthorization({
    userCode: created.userCode,
    codebaseId: 'device-auth-core',
    actor: { userId: 'user_owner' },
  })
  assert.equal(approved.status, 'approved')
  const polled = await backend.pollDeviceAuthorization(created.deviceCode)
  assert.equal(polled.status, 'approved')
  assert.equal(polled.codebaseId, 'device-auth-core')
  assert.equal(polled.requesterId, 'user_owner')
  assert.match(polled.sessionId, /^session_/)
  const token = unwrapSymmetricKeyFromDevice({
    wrappedKey: polled.wrappedSessionToken,
    recipientPrivateKeyPem: device.encryption.privateKeyPem,
    context: polled.tokenContext,
  }).toString('utf8')
  assert.match(token, /^hst_/)

  const scoped = createD1Backend({
    'codebase-id': 'device-auth-core',
    'd1-api-base-url': server.baseUrl,
    'session-token': token,
  })
  assert.equal((await scoped.readGraph()).codebase.id, 'device-auth-core')
  const stored = server.db.prepare(
    'select device_code_hash, wrapped_session_token_json from device_authorizations where authorization_id = ?',
  ).get(created.authorizationId)
  assert.notEqual(stored.device_code_hash, created.deviceCode)
  assert.equal(stored.device_code_hash.includes(created.deviceCode), false)
  assert.equal(stored.wrapped_session_token_json.includes(token), false)
  assert.equal((await backend.pollDeviceAuthorization('hdc_' + 'x'.repeat(43))).status, 'not_found')
})

test('collaborator device authorization preserves identity and visibility on scoped reads', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = createD1Backend({
    'codebase-id': 'collaborator-device-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const graph = makeD1Graph({
    codebaseId: 'collaborator-device-core',
    files: {
      'README.md': { kind: 'file', content: 'shared\n', encoding: 'utf8', revision: 1 },
      '.private/notes.md': { kind: 'file', content: 'owner only\n', encoding: 'utf8', revision: 1 },
    },
  })
  graph.collaborators = [{ id: 'user_collaborator', role: 'member', status: 'active' }]
  graph.visibility = { ...graph.visibility, changeSetOverride: 'team-visible', effective: 'team-visible' }
  graph.selectedState = {
    ...graph.selectedState,
    visibility: 'team-visible',
    effectiveVisibility: 'team-visible',
  }
  await backend.initialize(graph)

  const device = createDeviceKeyMaterial({
    deviceId: 'dev_collaborator_auth_test',
    deviceName: 'Collaborator Device',
    platform: 'test-platform',
  })
  const created = await backend.createDeviceAuthorization({
    deviceKey: publicDeviceKeyDescriptor(device),
    requestFingerprint: 'collaborator_fingerprint_test',
  })
  await backend.approveDeviceAuthorization({
    userCode: created.userCode,
    codebaseId: 'collaborator-device-core',
    actor: { userId: 'user_collaborator' },
  })
  const polled = await backend.pollDeviceAuthorization(created.deviceCode)
  assert.equal(polled.requesterId, 'user_collaborator')

  const token = unwrapSymmetricKeyFromDevice({
    wrappedKey: polled.wrappedSessionToken,
    recipientPrivateKeyPem: device.encryption.privateKeyPem,
    context: polled.tokenContext,
  }).toString('utf8')
  const scoped = new D1CloudGraphService({
    'codebase-id': 'collaborator-device-core',
    'd1-api-base-url': server.baseUrl,
    'session-token': token,
    'requester-id': polled.requesterId,
    'session-id': polled.sessionId,
  })
  const visible = await scoped.readVisibleGraph({
    requesterId: polled.requesterId,
    sessionId: polled.sessionId,
  })
  assert.deepEqual(Object.keys(visible.files), ['README.md'])
  assert.equal(visible.visibilityContext.id, 'user_collaborator')
  assert.equal(visible.visibilityContext.role, 'member')

  const sessionOnly = await scoped.readVisibleGraph({ sessionId: polled.sessionId })
  assert.deepEqual(Object.keys(sessionOnly.files), [])
  assert.equal(sessionOnly.visibilityContext.isOwner, false)
})

test('D1 backend records file versions and compares retained revisions', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = createD1Backend({
    'codebase-id': 'history-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const now = '2026-07-08T00:00:00.000Z'
  await backend.initialize({
    schemaVersion: 2,
    codebase: {
      id: 'history-core',
      name: 'History Core',
      ownerId: 'user_owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: now,
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_history_core',
      ownerId: 'user_owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'team-visible',
      effectiveVisibility: 'team-visible',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: 'user_owner',
      name: 'Owner',
    },
    collaborators: [{ id: 'user_collab', role: 'member' }],
    session: {
      id: 'session_history',
      deviceName: 'test',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'team-visible',
      effective: 'team-visible',
    },
    revision: 1,
    files: {
      'README.md': {
        kind: 'file',
        content: '# History\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
      '.private/note.md': {
        kind: 'file',
        content: 'owner note\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
    },
  })

  await backend.mutateTextFile({
    codebaseId: 'history-core',
    path: 'README.md',
    content: '# History\n\nEdited in D1.\n',
    baseRevision: 1,
    actor: { userId: 'user_owner' },
  })
  await backend.mutateTextFile({
    codebaseId: 'history-core',
    path: 'src/new.js',
    content: 'export const added = true\n',
    actor: { userId: 'user_owner' },
  })

  const versions = await backend.listFileVersions('history-core')
  assert.equal(versions.length, 4)
  assert.deepEqual(versions.map((row) => [row.path, row.graphRevision]), [
    ['.private/note.md', 1],
    ['README.md', 1],
    ['README.md', 2],
    ['src/new.js', 3],
  ])

  const ownerCompare = await backend.compareRevisions(1, 3, {
    codebaseId: 'history-core',
    requesterId: 'user_owner',
    path: 'README.md',
  })
  assert.equal(ownerCompare.ok, true)
  assert.deepEqual(ownerCompare.summary, {
    added: 1,
    modified: 1,
    deleted: 0,
    unchanged: 1,
    missingBlob: 0,
    integrityFailures: 0,
    requiresLocalKey: 0,
    binaryChanged: 0,
  })
  assert.deepEqual(ownerCompare.entries.find((entry) => entry.path === 'README.md').body.diff.addedLines, [
    '',
    'Edited in D1.',
  ])

  const collaboratorCompare = await backend.compareRevisions(1, 3, {
    codebaseId: 'history-core',
    requesterId: 'user_collab',
  })
  assert.equal(collaboratorCompare.entries.some((entry) => entry.path.startsWith('.private/')), false)
  assert.equal(collaboratorCompare.entries.some((entry) => entry.path === 'README.md'), true)

  const objectHash = createHash('sha256').update('object body\n').digest('hex')
  const objectGraph = await backend.readGraph('history-core')
  objectGraph.revision = 4
  objectGraph.selectedState.revision = 4
  objectGraph.files['OBJECT.md'] = {
    kind: 'file',
    content: '',
    encoding: 'utf8',
    contentStorage: 'object-blob',
    blobProvider: 'filesystem',
    blobKey: `codebases/history-core/blobs/sha256/${objectHash.slice(0, 2)}/${objectHash}`,
    blobHash: objectHash,
    blobSize: Buffer.byteLength('object body\n'),
    hash: objectHash,
    size: Buffer.byteLength('object body\n'),
    scope: 'shared',
    privacyZone: 'repo-content',
    revision: 4,
    updatedAt: now,
  }
  await backend.writeGraph(objectGraph, { actor: { userId: 'user_owner' } })
  const missingCompare = await backend.compareRevisions(3, 4, {
    codebaseId: 'history-core',
    requesterId: 'user_owner',
    path: 'OBJECT.md',
  })
  const objectEntry = missingCompare.entries.find((entry) => entry.path === 'OBJECT.md')
  assert.equal(objectEntry.state, 'missing_blob')
  assert.equal(missingCompare.summary.missingBlob, 1)

  await assert.rejects(
    () => backend.mutateTextFile({
      codebaseId: 'history-core',
      path: 'OBJECT.md',
      content: 'object body changed\n',
      baseRevision: 4,
      actor: { userId: 'user_owner' },
    }),
    (error) => {
      assert.equal(error.code, 'object_blob_upload_required')
      return true
    },
  )
  const objectAfterRejectedEdit = (await backend.readGraph('history-core')).files['OBJECT.md']
  assert.equal(objectAfterRejectedEdit.contentStorage, 'object-blob')
  assert.equal(objectAfterRejectedEdit.blobProvider, 'filesystem')
  assert.equal(objectAfterRejectedEdit.blobKey, objectGraph.files['OBJECT.md'].blobKey)
  assert.equal(objectAfterRejectedEdit.blobHash, objectHash)
  assert.equal(objectAfterRejectedEdit.revision, 4)
})

async function startD1ApiServer(t, { statements = null, statementRecords = null, requestBatches = null, pushNamespace = null } = {}) {
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db, statements, statementRecords),
    HOPIT_D1_PROXY_TOKEN: 'token_test',
    HOPIT_D1_PROXY_LOG_REQUESTS: '0',
  }
  if (pushNamespace) env.HOPIT_PUSH_HUB = pushNamespace
  const server = createServer(async (request, response) => {
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request)
      if (requestBatches && body) {
        const parsed = JSON.parse(body)
        requestBatches.push(Array.isArray(parsed) ? parsed : [parsed])
      }
      const workerRequest = new Request(`http://127.0.0.1${request.url ?? '/query'}`, {
        method: request.method,
        headers: request.headers,
        body,
      })
      const workerResponse = await d1ApiWorker.fetch(workerRequest, env)
      response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()))
      response.end(await workerResponse.text())
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        result: [{ success: false, results: [], error: error instanceof Error ? error.message : 'query failed' }],
      }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    db.close()
    server.close()
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('D1 test server did not bind a port.')
  return { baseUrl: `http://127.0.0.1:${port}`, db }
}

function d1Binding(db, statements = null, statementRecords = null) {
  return {
    prepare(sql) {
      statements?.push(sql)
      const statement = db.prepare(sql)
      return {
        bind(...params) {
          statementRecords?.push({ sql, params })
          return {
            all() {
              const isSelect = sql.trim().toLowerCase().startsWith('select')
              const result = isSelect ? null : statement.run(...params)
              const rows = isSelect ? statement.all(...params) : []
              return {
                results: rows,
                meta: {
                  changes: result?.changes ?? 0,
                },
              }
            },
          }
        },
      }
    },
  }
}

function createRecordingPushNamespace() {
  const namespace = {
    idNames: [],
    fetches: [],
    notifications: [],
    idFromName(name) {
      namespace.idNames.push(name)
      return `id:${name}`
    },
    get(id) {
      return {
        async fetch(request, init) {
          const normalizedRequest = request instanceof Request ? request : new Request(request, init)
          namespace.fetches.push({ id, request: normalizedRequest })
          if (normalizedRequest.method === 'POST') {
            namespace.notifications.push(await normalizedRequest.json())
            return new Response(JSON.stringify({ success: true }), { status: 200 })
          }
          return new Response('upgrade-ok')
        },
      }
    },
  }
  return namespace
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function readNdjson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-d1-test-'))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

function stateArgs(state) {
  return [
    '--cloud',
    state.cloud,
    '--workspace',
    state.workspace,
    '--journal',
    state.journal,
    '--events',
    state.events,
  ]
}

function makeD1Graph({ codebaseId = 'd1-core', revision = 1, files = {}, now = '2026-07-08T00:00:00.000Z' } = {}) {
  return {
    schemaVersion: 2,
    codebase: { id: codebaseId, name: codebaseId, ownerId: 'user_owner' },
    main: { id: 'main', revision, updatedAt: now, mergedChangeSetId: null },
    selectedState: {
      type: 'active-change-set',
      id: `cs_${codebaseId.replace(/[^a-z0-9]+/gi, '_')}`,
      ownerId: 'user_owner',
      baseMainId: 'main',
      baseRevision: revision,
      revision,
      visibility: 'private',
      effectiveVisibility: 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: { id: 'user_owner', name: 'Owner' },
    collaborators: [],
    session: { id: `session_${codebaseId.replace(/[^a-z0-9]+/gi, '_')}`, deviceName: 'test' },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: null,
      effective: 'private',
    },
    revision,
    files,
  }
}

async function runCli(command, args = []) {
  return await execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  })
}

test('browser D1 file mutations advance only the selected change set and preserve concurrent paths', async (t) => {
  const statementRecords = []
  const server = await startD1ApiServer(t, { statementRecords })
  const now = '2026-07-08T00:00:00.000Z'
  const backend = createD1Backend({
    'codebase-id': 'browser-mutation-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({
    codebaseId: 'browser-mutation-core',
    now,
    files: {
      'README.md': {
        kind: 'file',
        content: 'readme one\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
      'src/other.js': {
        kind: 'file',
        content: 'export const other = 1\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
    },
  }))
  const initial = await backend.readGraph()
  const initialMain = structuredClone(initial.main)

  statementRecords.length = 0
  const first = await backend.mutateTextFile({
    codebaseId: 'browser-mutation-core',
    path: 'README.md',
    content: 'readme two\n',
    baseRevision: 1,
    actor: { userId: 'user_owner' },
  })
  assert.equal(first.revision, 2)
  assert.equal(first.selectedStateId, initial.selectedState.id)
  assert.equal(first.selectedStateRevision, 2)

  const afterFirst = await backend.readGraph()
  assert.deepEqual(afterFirst.main, initialMain)
  assert.equal(afterFirst.revision, 2)
  assert.equal(afterFirst.selectedState.revision, afterFirst.revision)
  assert.equal(afterFirst.selectedState.baseRevision, initialMain.revision)
  assert.equal(afterFirst.files['README.md'].revision, 2)
  assert.equal(afterFirst.files['src/other.js'].revision, 1)

  await assert.rejects(
    () => backend.mutateTextFile({
      codebaseId: 'browser-mutation-core',
      path: 'README.md',
      content: 'stale overwrite\n',
      baseRevision: 1,
      actor: { userId: 'user_owner' },
    }),
    (error) => {
      assert.equal(error.code, 'base_revision_mismatch')
      assert.equal(error.detail.expectedRevision, 1)
      assert.equal(error.detail.actualRevision, 2)
      return true
    },
  )
  const afterMismatch = await backend.readGraph()
  assert.equal(afterMismatch.revision, 2)
  assert.equal(afterMismatch.files['README.md'].content, 'readme two\n')

  const switchedState = { ...afterFirst.selectedState, id: 'cs_browser_switched' }
  server.db.prepare(
    `update codebases set selected_state_json = ? where codebase_id = ?`,
  ).run(JSON.stringify(switchedState), 'browser-mutation-core')
  await assert.rejects(
    () => backend.mutateTextFile({
      codebaseId: 'browser-mutation-core',
      path: 'README.md',
      content: 'must not cross change sets\n',
      baseRevision: 2,
      selectedStateId: initial.selectedState.id,
      actor: { userId: 'user_owner' },
    }),
    (error) => {
      assert.equal(error.code, 'selected_state_id_mismatch')
      assert.equal(error.detail.expectedId, initial.selectedState.id)
      assert.equal(error.detail.actualId, 'cs_browser_switched')
      return true
    },
  )
  server.db.prepare(
    `update codebases set selected_state_json = ? where codebase_id = ?`,
  ).run(JSON.stringify(afterFirst.selectedState), 'browser-mutation-core')

  const otherBackend = createD1Backend({
    'codebase-id': 'browser-mutation-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  let gatedReads = 0
  let releaseReads
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve
  })
  for (const candidate of [backend, otherBackend]) {
    const readGraph = candidate.readGraph.bind(candidate)
    let gated = false
    candidate.readGraph = async (...args) => {
      const graph = await readGraph(...args)
      if (gated) return graph
      gated = true
      gatedReads += 1
      if (gatedReads === 2) releaseReads()
      await bothRead
      return graph
    }
  }

  const concurrentResults = await Promise.all([
    backend.mutateTextFile({
      codebaseId: 'browser-mutation-core',
      path: 'README.md',
      content: 'readme three\n',
      baseRevision: 2,
      actor: { userId: 'user_owner' },
    }),
    otherBackend.mutateTextFile({
      codebaseId: 'browser-mutation-core',
      path: 'src/other.js',
      content: 'export const other = 2\n',
      baseRevision: 1,
      actor: { userId: 'user_owner' },
    }),
  ])
  assert.deepEqual(concurrentResults.map((result) => result.revision).sort((left, right) => left - right), [3, 4])

  const finalGraph = await backend.readGraph()
  assert.deepEqual(finalGraph.main, initialMain)
  assert.equal(finalGraph.revision, 4)
  assert.equal(finalGraph.selectedState.revision, finalGraph.revision)
  assert.equal(finalGraph.files['README.md'].content, 'readme three\n')
  assert.equal(finalGraph.files['src/other.js'].content, 'export const other = 2\n')
  assert.equal(finalGraph.files['README.md'].contentStorage, 'inline')
  assert.equal(finalGraph.files['src/other.js'].contentStorage, 'inline')

  const mutationStatements = statementRecords.map((record) => record.sql)
  assert.equal(mutationStatements.filter((sql) => /^\s*update\s+codebases\s+set\s+revision\s*=\s*\?/i.test(sql)).length, 4)
  assert.equal(mutationStatements.some((sql) => /^\s*insert\s+into\s+codebases\b/i.test(sql)), false)
  assert.equal(mutationStatements.some((sql) => /path\s+not\s+in/i.test(sql)), false)
  assert.equal(mutationStatements.some((sql) => /^\s*delete\s+from\s+files\s+where\s+codebase_id\s*=\s*\?\s*$/i.test(sql)), false)

  const versions = await backend.listFileVersions()
  const mutationVersions = versions.filter((row) => row.graphRevision > 1)
  assert.deepEqual(mutationVersions.map((row) => row.graphRevision), [2, 3, 4])
  assert.equal(mutationVersions[0].path, 'README.md')
  assert.deepEqual(mutationVersions.slice(1).map((row) => row.path).sort(), ['README.md', 'src/other.js'])
  const mutationEvents = server.db.prepare(
    `select detail_json from agent_events where codebase_id = ? and event = 'file.mutated' order by id asc`,
  ).all('browser-mutation-core')
  assert.equal(mutationEvents.length, 3)
  assert.deepEqual(
    mutationEvents.map((row) => JSON.parse(row.detail_json).selectedStateRevision),
    [2, 3, 4],
  )
})

test('D1 journal commit uses bounded per-file statements on wide graphs', async (t) => {
  const statementRecords = []
  const server = await startD1ApiServer(t, { statementRecords })
  const now = '2026-07-08T00:00:00.000Z'
  const files = {}
  for (let index = 0; index < 120; index += 1) {
    files[`src/file-${String(index).padStart(3, '0')}.js`] = {
      kind: 'file',
      content: `export const value${index} = ${index}\n`,
      encoding: 'utf8',
      revision: 1,
      updatedAt: now,
    }
  }
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-wide-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({ codebaseId: 'journal-wide-core', files, now }))
  const cloud = await backend.readGraph()

  statementRecords.length = 0
  const acknowledgement = await backend.commitJournalEntry(cloud, {
    id: 'entry-wide-1',
    type: 'write',
    path: 'src/file-060.js',
    baseRevision: 1,
    targetStateRevision: 1,
  }, {
    content: 'export const value60 = 6000\n',
    now: '2026-07-08T00:01:00.000Z',
  })

  assert.equal(acknowledgement.storageMode, 'd1-file-mutation')
  assert.ok(statementRecords.length < 10, `expected bounded journal statements, saw ${statementRecords.length}`)
  assert.equal(statementRecords.filter((record) => /^\s*insert\s+into\s+files\b/i.test(record.sql)).length, 1)
  assert.equal(statementRecords.some((record) => /path\s+not\s+in/i.test(record.sql)), false)
  assert.equal(statementRecords.some((record) => /delete\s+from\s+files\s+where\s+codebase_id\s+=\s+\?\s+and\s+path\s+not\s+in/i.test(record.sql)), false)

  const written = await backend.readGraph()
  assert.equal(written.revision, 2)
  assert.equal(written.main.revision, 1)
  assert.equal(written.selectedState.revision, 2)
  assert.equal(Object.keys(written.files).length, 120)
  assert.equal(written.files['src/file-060.js'].content, 'export const value60 = 6000\n')
  assert.equal(written.files['src/file-061.js'].content, 'export const value61 = 61\n')
  const versions = await backend.listFileVersions()
  assert.equal(versions.filter((row) => row.graphRevision === 2).length, 1)
  assert.equal(versions.find((row) => row.graphRevision === 2).path, 'src/file-060.js')
})

test('D1 bulk journal commit chunks wide imports into bounded requests', async (t) => {
  const statementRecords = []
  const requestBatches = []
  const pushNamespace = createRecordingPushNamespace()
  const server = await startD1ApiServer(t, { statementRecords, requestBatches, pushNamespace })
  const now = '2026-07-08T00:00:00.000Z'
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-bulk-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({ codebaseId: 'journal-bulk-core', files: {}, now }))
  const cloud = await backend.readGraph()
  const entries = []
  const entryPayloads = new Map()
  for (let index = 0; index < 300; index += 1) {
    const filePath = `src/imported-${String(index).padStart(3, '0')}.js`
    const entry = {
      id: `bulk-entry-${index}`,
      type: 'create',
      path: filePath,
      kind: 'file',
      baseRevision: null,
      createdAt: now,
      status: 'pending',
    }
    entries.push(entry)
    entryPayloads.set(entry.id, {
      kind: 'file',
      content: `export const imported${index} = ${index}\n`,
      encoding: 'utf8',
    })
  }

  statementRecords.length = 0
  requestBatches.length = 0
  pushNamespace.notifications.length = 0
  const chunks = []
  const acknowledgements = await backend.commitJournalEntries(cloud, entries, {
    entryPayloads,
    now: '2026-07-08T00:05:00.000Z',
    chunkSize: 40,
    onChunkCommitted: (chunk) => {
      chunks.push(chunk)
    },
  })

  assert.equal(acknowledgements.length, 300)
  assert.equal(acknowledgements.every((entry) => entry.storageMode === 'd1-bulk-mutation'), true)
  assert.equal(chunks.length, 8)
  assert.equal(requestBatches.length, 8)
  assert.deepEqual(requestBatches.map((batch) => batch.length), [81, 81, 81, 81, 81, 81, 81, 41])
  assert.equal(Math.max(...statementRecords.map((record) => record.params.length)), 29)
  assert.equal(statementRecords.every((record) => record.params.length <= 100), true)
  assert.equal(pushNamespace.notifications.length, 8)

  const written = await backend.readGraph()
  assert.equal(written.revision, 301)
  assert.equal(written.main.revision, 1)
  assert.equal(written.selectedState.revision, 301)
  assert.equal(Object.keys(written.files).length, 300)
  assert.equal(written.files['src/imported-299.js'].content, 'export const imported299 = 299\n')
  const versions = await backend.listFileVersions()
  assert.equal(versions.length, 300)
  assert.equal(versions.filter((row) => row.operation === 'add').length, 300)
  assert.equal(versions.at(-1).path, 'src/imported-299.js')
})

test('D1 bulk journal commit stops on a raced chunk without partial rows', async (t) => {
  const statementRecords = []
  const server = await startD1ApiServer(t, { statementRecords })
  const now = '2026-07-08T00:00:00.000Z'
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-bulk-race-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({ codebaseId: 'journal-bulk-race-core', files: {}, now }))
  const cloud = await backend.readGraph()
  const entries = []
  const entryPayloads = new Map()
  for (let index = 0; index < 100; index += 1) {
    const filePath = `src/raced-${String(index).padStart(3, '0')}.js`
    const entry = {
      id: `bulk-race-entry-${index}`,
      type: 'create',
      path: filePath,
      kind: 'file',
      baseRevision: null,
      createdAt: now,
      status: 'pending',
    }
    entries.push(entry)
    entryPayloads.set(entry.id, {
      kind: 'file',
      content: `export const raced${index} = ${index}\n`,
      encoding: 'utf8',
    })
  }

  const acknowledged = []
  await assert.rejects(
    () => backend.commitJournalEntries(cloud, entries, {
      entryPayloads,
      now: '2026-07-08T00:06:00.000Z',
      chunkSize: 40,
      onChunkCommitted: (chunk) => {
        acknowledged.push(...chunk.acknowledgements)
        if (chunk.chunkIndex === 0) {
          server.db.prepare(`update codebases set revision = ? where codebase_id = ?`).run(999, 'journal-bulk-race-core')
        }
      },
    }),
    (error) => {
      assert.equal(error.name, 'ConflictError')
      assert.equal(error.detail.reason, 'selected_state_revision_mismatch')
      assert.equal(error.detail.id, 'bulk-race-entry-40')
      return true
    },
  )

  assert.equal(acknowledged.length, 40)
  assert.equal(acknowledged.every((entry) => entry.storageMode === 'd1-bulk-mutation'), true)
  const rows = server.db.prepare(`select path from files where codebase_id = ? order by path asc`).all('journal-bulk-race-core')
  assert.equal(rows.length, 40)
  assert.equal(rows.some((row) => row.path === 'src/raced-040.js'), false)
  const versionRows = await backend.listFileVersions()
  assert.equal(versionRows.length, 40)
  assert.equal(versionRows.some((row) => row.path === 'src/raced-040.js'), false)
})

test('D1 journal delete removes the file row and writes a tombstone version', async (t) => {
  const server = await startD1ApiServer(t)
  const now = '2026-07-08T00:00:00.000Z'
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-delete-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({
    codebaseId: 'journal-delete-core',
    now,
    files: {
      'README.md': {
        kind: 'file',
        content: '# Delete me\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
    },
  }))
  const cloud = await backend.readGraph()

  const acknowledgement = await backend.commitJournalEntry(cloud, {
    id: 'entry-delete-1',
    type: 'delete',
    path: 'README.md',
    baseRevision: 1,
    targetStateRevision: 1,
  }, { now: '2026-07-08T00:02:00.000Z' })

  assert.equal(acknowledgement.storageMode, 'd1-file-mutation')
  const written = await backend.readGraph()
  assert.equal(written.revision, 2)
  assert.equal(written.files['README.md'], undefined)
  const versions = await backend.listFileVersions()
  const tombstone = versions.find((row) => row.path === 'README.md' && row.graphRevision === 2)
  assert.equal(tombstone.operation, 'delete')
  assert.equal(tombstone.oldRevision, 1)
  assert.equal(tombstone.newRevision, null)
  assert.equal(tombstone.oldFile.content, '# Delete me\n')
  assert.equal(tombstone.newFile, null)
})

test('D1 journal commit detects a remote head race without partial file writes', async (t) => {
  const statementRecords = []
  const server = await startD1ApiServer(t, { statementRecords })
  const now = '2026-07-08T00:00:00.000Z'
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-race-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize(makeD1Graph({
    codebaseId: 'journal-race-core',
    now,
    files: {
      'README.md': {
        kind: 'file',
        content: 'original\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
    },
  }))
  const cloud = await backend.readGraph()
  const cloudBeforeRejectedCommit = structuredClone(cloud)
  server.db.prepare(`update codebases set revision = ? where codebase_id = ?`).run(99, 'journal-race-core')

  statementRecords.length = 0
  await assert.rejects(
    () => backend.commitJournalEntry(cloud, {
      id: 'entry-race-1',
      type: 'write',
      path: 'README.md',
      baseRevision: 1,
      targetStateRevision: 1,
    }, {
      content: 'should not persist\n',
      now: '2026-07-08T00:03:00.000Z',
    }),
    (error) => {
      assert.equal(error.name, 'ConflictError')
      assert.equal(error.detail.reason, 'selected_state_revision_mismatch')
      return true
    },
  )

  assert.ok(statementRecords.length < 10, `expected bounded failed journal statements, saw ${statementRecords.length}`)
  const written = await backend.readGraph()
  assert.equal(written.files['README.md'].content, 'original\n')
  assert.equal(written.files['README.md'].revision, 1)
  assert.deepEqual(cloud, cloudBeforeRejectedCommit)
  const versions = await backend.listFileVersions()
  assert.equal(versions.some((row) => row.graphRevision === 2), false)
})

test('agent D1 service cannot journal directly into Main or a merged change set', () => {
  const backend = new D1CloudGraphService({
    'codebase-id': 'journal-state-guard-core',
    'd1-api-base-url': 'https://example.invalid',
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const mainGraph = makeD1Graph({ codebaseId: 'journal-state-guard-core' })
  mainGraph.selectedState = { type: 'main', id: 'main', revision: 1 }
  assert.throws(
    () => backend.applyJournalEntry(mainGraph, {
      id: 'entry-main-rejected',
      type: 'write',
      path: 'README.md',
      baseRevision: 1,
    }, { entry: { kind: 'file', content: 'rejected\n', encoding: 'utf8' } }),
    (error) => error.code === 'selected_state_not_writable',
  )

  const mergedGraph = makeD1Graph({ codebaseId: 'journal-state-guard-core' })
  mergedGraph.selectedState.mergeState = 'merged'
  assert.throws(
    () => backend.applyJournalEntry(mergedGraph, {
      id: 'entry-merged-rejected',
      type: 'write',
      path: 'README.md',
      baseRevision: 1,
    }, { entry: { kind: 'file', content: 'rejected\n', encoding: 'utf8' } }),
    (error) => error.code === 'selected_state_already_merged',
  )
})

test('scoped D1 session can commit a per-file journal entry and emits one push envelope', async (t) => {
  const pushNamespace = createRecordingPushNamespace()
  const server = await startD1ApiServer(t, { pushNamespace })
  const now = '2026-07-08T00:00:00.000Z'
  const admin = new D1CloudGraphService({
    'codebase-id': 'journal-scoped-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await admin.initialize(makeD1Graph({
    codebaseId: 'journal-scoped-core',
    now,
    files: {
      'README.md': {
        kind: 'file',
        content: 'scoped original\n',
        encoding: 'utf8',
        revision: 1,
        updatedAt: now,
      },
    },
  }))
  const registered = await admin.registerAgentSession({
    codebaseId: 'journal-scoped-core',
    sessionId: 'session_journal_scoped',
    deviceName: 'Scoped Commit Device',
    capabilities: ['read', 'write'],
  })
  const scoped = new D1CloudGraphService({
    'codebase-id': 'journal-scoped-core',
    'd1-api-base-url': server.baseUrl,
    'session-token': registered.sessionToken,
  })
  const cloud = await scoped.readGraph()
  pushNamespace.notifications.length = 0

  const acknowledgement = await scoped.commitJournalEntry(cloud, {
    id: 'entry-scoped-1',
    type: 'write',
    path: 'README.md',
    baseRevision: 1,
    targetStateRevision: 1,
    sessionId: 'session_journal_scoped',
  }, {
    content: 'scoped changed\n',
    now: '2026-07-08T00:04:00.000Z',
  })

  assert.equal(acknowledgement.storageMode, 'd1-file-mutation')
  const written = await admin.readGraph()
  assert.equal(written.files['README.md'].content, 'scoped changed\n')
  assert.equal(pushNamespace.notifications.length, 1)
  assert.equal(pushNamespace.notifications[0].codebaseId, 'journal-scoped-core')
  assert.equal(pushNamespace.notifications[0].revision, 2)
  assert.deepEqual(pushNamespace.notifications[0].changedPaths, ['README.md'])
})

test('writeGraph stays under the D1 bound-variable limit for graphs over 90 files', async (t) => {
  const statements = []
  const server = await startD1ApiServer(t, { statements })
  const backend = createD1Backend({
    'codebase-id': 'wide-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  const now = '2026-07-08T00:00:00.000Z'
  const files = {}
  for (let index = 0; index < 120; index += 1) {
    files[`src/file-${String(index).padStart(3, '0')}.js`] = {
      kind: 'file',
      content: `export const value${index} = ${index}\n`,
      encoding: 'utf8',
      revision: 1,
      updatedAt: now,
    }
  }
  const graph = {
    schemaVersion: 2,
    codebase: { id: 'wide-core', name: 'Wide Core', ownerId: 'user_owner' },
    main: { id: 'main', revision: 1, updatedAt: now, mergedChangeSetId: null },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_wide_core',
      ownerId: 'user_owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'private',
      effectiveVisibility: 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: { id: 'user_owner', name: 'Owner' },
    collaborators: [],
    session: { id: 'session_wide', deviceName: 'test' },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: null,
      effective: 'private',
    },
    revision: 1,
    files,
  }

  await backend.initialize(graph)

  const removedPath = 'src/file-000.js'
  const nextFiles = { ...files }
  delete nextFiles[removedPath]
  statements.length = 0
  await backend.writeGraph({ ...graph, revision: 2, files: nextFiles })

  const maxPlaceholders = Math.max(...statements.map((sql) => (sql.match(/\?/g) ?? []).length))
  assert.ok(
    maxPlaceholders <= 100,
    `expected every statement to stay within D1's 100 bound-variable limit, saw ${maxPlaceholders}`,
  )

  const written = await backend.readGraph('wide-core')
  assert.equal(Object.keys(written.files).length, 119)
  assert.equal(written.files[removedPath], undefined)
  assert.equal(written.files['src/file-001.js'].content, 'export const value1 = 1\n')
})
