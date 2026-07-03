import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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

async function startD1ApiServer(t, { statements = null } = {}) {
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db, statements),
    HOPIT_D1_PROXY_TOKEN: 'token_test',
  }
  const server = createServer(async (request, response) => {
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request)
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

function d1Binding(db, statements = null) {
  return {
    prepare(sql) {
      statements?.push(sql)
      const statement = db.prepare(sql)
      return {
        bind(...params) {
          return {
            all() {
              const rows = sql.trim().toLowerCase().startsWith('select')
                ? statement.all(...params)
                : (statement.run(...params), [])
              return {
                results: rows,
                meta: {},
              }
            },
          }
        },
      }
    },
  }
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

async function runCli(command, args = []) {
  return await execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  })
}
