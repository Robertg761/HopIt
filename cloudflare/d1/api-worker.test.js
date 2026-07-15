import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import worker, { CodebasePushHub } from './api-worker.js'
import { assertScopedSessionStatementAllowed, assertServerActorStatementAllowed } from './scoped-sql.js'
import { assertBrokerKeyForCodebase, isBrokerKeyForCodebase, presignBlobUrl } from './blob-broker.js'
import {
  buildMeterUpsertStatement,
  computeUsageStatus,
  evaluateWriteQuota,
  meterState,
  resolvePlanLimits,
  rowsUsedToday,
  utcDay,
} from './quota.js'

test('proxy token auth executes statements and logs structured request metadata', async () => {
  const logs = await captureLogs(async () => {
    const db = createMockDb()
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify([
        { sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] },
        { sql: 'select * from codebases where id = ?', params: ['codebase-1'] },
      ]),
    }), {
      HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
      HOPIT_D1_DB: db,
    })

    assert.equal(response.status, 200)
    assert.equal(db.executedStatements.length, 2)
  })

  assert.equal(logs.length, 1)
  const log = JSON.parse(logs[0])
  assert.equal(log.authMode, 'proxy')
  assert.equal(log.codebaseId, 'codebase-1')
  assert.equal(log.statementCount, 2)
  assert.equal(log.status, 200)
  assert.equal(logs[0].includes('select *'), false)
  assert.equal(logs[0].includes('proxy-secret'), false)
})

test('scoped session auth validates the session and logs session mode', async () => {
  const db = createMockDb({
    session: {
      session_id: 'session-1',
      user_id: 'user-1',
      codebase_id: 'codebase-1',
      status: 'active',
      expires_at: null,
      capabilities_json: JSON.stringify(['read']),
    },
  })

  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer hst_session_token',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.11',
      },
      body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] }),
    }), {
      HOPIT_D1_DB: db,
    })

    assert.equal(response.status, 200)
  })

  assert.equal(db.sessionLookups, 1)
  const log = JSON.parse(logs.at(-1))
  assert.equal(log.authMode, 'session')
  assert.equal(log.codebaseId, 'codebase-1')
  assert.equal(log.statementCount, 1)
})

test('scoped canonical file reads hide every active private-draft row from non-owners', async () => {
  const db = createMockDb({
    session: scopedSession({
      user_id: 'user-member',
      capabilities_json: JSON.stringify(['read']),
    }),
    codebase: {
      codebase_id: 'codebase-1',
      owner_id: 'user-owner',
      selected_state_json: JSON.stringify({ type: 'active-change-set', effectiveVisibility: 'private' }),
      visibility_json: JSON.stringify({ effective: 'private' }),
    },
    membership: { role: 'member', status: 'active' },
    files: [
      { codebase_id: 'codebase-1', path: 'README.md', scope: 'shared', content: 'hidden draft' },
      { codebase_id: 'codebase-1', path: '.private/token.txt', scope: 'owner-private', content: 'owner secret' },
    ],
  })

  const response = await worker.fetch(scopedQueryRequest(
    { sql: 'select * from files where codebase_id = ? order by path asc', params: ['codebase-1'] },
    '203.0.113.40',
  ), { HOPIT_D1_DB: db })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.result[0].results, [])
  assert.equal(JSON.stringify(body).includes('hidden draft'), false)
  assert.equal(JSON.stringify(body).includes('owner secret'), false)
})

test('scoped team-visible file reads expose shared rows but never owner-private rows', async () => {
  const db = createMockDb({
    session: scopedSession({
      user_id: 'user-member',
      capabilities_json: JSON.stringify(['read']),
    }),
    codebase: {
      codebase_id: 'codebase-1',
      owner_id: 'user-owner',
      selected_state_json: JSON.stringify({ type: 'active-change-set', effectiveVisibility: 'team-visible' }),
      visibility_json: JSON.stringify({ effective: 'team-visible' }),
    },
    membership: { role: 'member', status: 'active' },
    files: [
      { codebase_id: 'codebase-1', path: 'README.md', scope: 'shared', content: 'visible draft' },
      { codebase_id: 'codebase-1', path: '.private/token.txt', scope: 'shared', content: 'owner secret' },
    ],
  })

  const response = await worker.fetch(scopedQueryRequest(
    { sql: 'select * from files where codebase_id = ? order by path asc', params: ['codebase-1'] },
    '203.0.113.41',
  ), { HOPIT_D1_DB: db })

  assert.equal(response.status, 200)
  const rows = (await response.json()).result[0].results
  assert.deepEqual(rows.map((row) => row.path), ['README.md'])
  assert.equal(JSON.stringify(rows).includes('owner secret'), false)
})

test('Worker rejects privileged rewrites from a write-only scoped session before execution', async () => {
  const db = createMockDb({
    session: scopedSession({ capabilities_json: JSON.stringify(['write']) }),
  })
  const response = await worker.fetch(scopedQueryRequest(
    { sql: 'update codebases set owner_id = ? where codebase_id = ?', params: ['attacker', 'codebase-1'] },
    '203.0.113.42',
  ), { HOPIT_D1_DB: db })

  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /admin capability/)
  assert.equal(db.executedStatements.length, 0)
})

test('scoped SQL policy accepts known file reads, guards, literals, and conflict updates', () => {
  const session = scopedSession()
  const statements = [
    { sql: 'select f.* from files f where f.codebase_id = ? order by f.path', params: ['codebase-1'] },
    {
      sql: `select m.*, u.primary_email from codebase_members m
        left join users u on u.user_id = m.user_id
        where m.codebase_id = ? and m.status = ?`,
      params: ['codebase-1', 'active'],
    },
    { sql: "select '-- not a comment' as note from issues where codebase_id = ?", params: ['codebase-1'] },
    {
      sql: `insert into files (codebase_id, path, content)
        values (?, ?, ?)
        on conflict(codebase_id, path) do update set content = excluded.content`,
      params: ['codebase-1', 'README.md', 'body'],
    },
    {
      sql: `delete from files where codebase_id = ? and path = ? and exists (
        select 1 from codebases
        where codebase_id = ? and revision = ? and updated_at = ?
      )`,
      params: ['codebase-1', 'README.md', 'codebase-1', 2, '2026-07-10T00:00:00.000Z'],
    },
  ]

  for (const statement of statements) {
    assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, statement))
  }
})

test('scoped SQL policy rejects cross-codebase predicates and SQL shape escapes', () => {
  const session = scopedSession()
  const hostileStatements = [
    { name: 'wrong equality parameter with decoy', sql: 'delete from files where codebase_id = ? and path = ?', params: ['codebase-2', 'codebase-1'] },
    { name: 'not equal', sql: 'delete from files where codebase_id <> ? and path = ?', params: ['codebase-2', 'codebase-1'] },
    { name: 'or', sql: 'delete from files where codebase_id = ? or codebase_id = ?', params: ['codebase-1', 'codebase-2'] },
    { name: 'multi-codebase in', sql: 'delete from files where codebase_id in (?, ?)', params: ['codebase-1', 'codebase-2'] },
    { name: 'union', sql: 'select * from files where codebase_id = ? union select * from files where codebase_id = ?', params: ['codebase-1', 'codebase-2'] },
    { name: 'subquery', sql: 'delete from files where codebase_id = ? and path in (select path from files where codebase_id = ?)', params: ['codebase-1', 'codebase-2'] },
    { name: 'guard-only scope', sql: 'delete from files where exists (select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?)', params: ['codebase-1', 2, 'now'] },
    { name: 'join', sql: 'select other.* from files own join files other on 1 = 1 where own.codebase_id = ?', params: ['codebase-1'] },
    { name: 'line comment', sql: 'select * from files where codebase_id = ? -- bypass', params: ['codebase-1'] },
    { name: 'block comment', sql: 'select * from files where codebase_id = ? /* bypass */', params: ['codebase-1'] },
    { name: 'multiple statements', sql: 'select * from files where codebase_id = ?; delete from files', params: ['codebase-1'] },
    { name: 'quoted scope decoy', sql: "select 'codebase_id = ?' from files where path = ?", params: ['README.md'] },
    { name: 'untyped file projection', sql: 'select content from files where codebase_id = ?', params: ['codebase-1'] },
    {
      name: 'unscoped conflict target',
      sql: 'insert into files (codebase_id, path, content) values (?, ?, ?) on conflict(path) do update set content = excluded.content',
      params: ['codebase-1', 'README.md', 'body'],
    },
    {
      name: 'codebase rewrite',
      sql: 'update files set codebase_id = ? where codebase_id = ?',
      params: ['codebase-2', 'codebase-1'],
    },
    {
      name: 'generic file update',
      sql: 'update files set content = ? where codebase_id = ? and path = ?',
      params: ['changed', 'codebase-1', 'README.md'],
    },
  ]

  for (const statement of hostileStatements) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }
})

test('scoped SQL policy permits key metadata only for the authenticated session user', () => {
  const session = scopedSession()
  const accepted = [
    { sql: 'select * from device_keys where user_id = ? and device_id = ? limit 1', params: ['user-1', 'device-1'] },
    { sql: 'update device_keys set last_seen_at = ? where user_id = ? and device_id = ?', params: ['now', 'user-1', 'device-1'] },
    { sql: 'insert into device_keys (device_id, user_id, status) values (?, ?, ?)', params: ['device-1', 'user-1', 'trusted'] },
    { sql: 'select * from user_keyrings where user_id = ? limit 1', params: ['user-1'] },
    { sql: 'insert into user_keyrings (user_id, vault_key_id) values (?, ?)', params: ['user-1', 'vault-1'] },
  ]
  for (const statement of accepted) {
    assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, statement), statement.sql)
  }

  const rejected = [
    { sql: 'select * from device_keys where device_id = ? limit 1', params: ['device-1'] },
    { sql: 'select * from device_keys where user_id = ? and device_id = ? limit 1', params: ['user-2', 'device-1'] },
    { sql: 'insert into device_keys (device_id, user_id, status) values (?, ?, ?)', params: ['device-1', 'user-2', 'trusted'] },
    { sql: 'update user_keyrings set status = ? where user_id = ?', params: ['active', 'user-2'] },
  ]
  for (const statement of rejected) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /authenticated user/,
      statement.sql,
    )
  }
})

test('generic write capability cannot rewrite privileged codebase, membership, session, or key state', () => {
  const session = scopedSession({ capabilities_json: JSON.stringify(['write']) })
  const privilegedStatements = [
    { sql: 'update codebases set owner_id = ? where codebase_id = ?', params: ['attacker', 'codebase-1'] },
    { sql: 'update codebases set owner_json = ? where codebase_id = ?', params: ['{}', 'codebase-1'] },
    { sql: 'update codebases set visibility_json = ? where codebase_id = ?', params: ['{"effective":"team-visible"}', 'codebase-1'] },
    { sql: 'update codebases set collaborators_json = ? where codebase_id = ?', params: ['[]', 'codebase-1'] },
    { sql: 'update codebases set session_json = ? where codebase_id = ?', params: ['{}', 'codebase-1'] },
    { sql: 'update codebases set member_count = ? where codebase_id = ?', params: [0, 'codebase-1'] },
    { sql: 'update codebase_members set role = ? where codebase_id = ? and user_id = ?', params: ['owner', 'codebase-1', 'user-1'] },
    { sql: 'update agent_sessions set capabilities_json = ? where codebase_id = ? and session_id = ?', params: ['["admin"]', 'codebase-1', 'session-1'] },
    { sql: 'update codebase_keyrings set status = ? where codebase_id = ?', params: ['active', 'codebase-1'] },
  ]

  for (const statement of privilegedStatements) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /admin capability/,
      statement.sql,
    )
  }
})

test('scoped SQL policy accepts codebase-scoped agent-session revoke and rejects cross-codebase or unscoped revoke', () => {
  const session = scopedSession()
  const revokeSql = `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
    where codebase_id = ? and session_id = ?`

  // Same-codebase admin revoke of another session, plus the lookup/read it needs.
  const accepted = [
    { sql: 'select * from agent_sessions where codebase_id = ? and session_id = ? limit 1', params: ['codebase-1', 'session-2'] },
    { sql: revokeSql, params: ['user-1', 'now', 'now', 'codebase-1', 'session-2'] },
    // Self-read stays a read (own codebase + own session id).
    { sql: 'select * from agent_sessions where codebase_id = ? and session_id = ? limit 1', params: ['codebase-1', 'session-1'] },
  ]
  for (const statement of accepted) {
    assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, statement), statement.sql)
  }

  const rejected = [
    { name: 'cross-codebase revoke lookup', sql: 'select * from agent_sessions where codebase_id = ? and session_id = ? limit 1', params: ['codebase-2', 'session-2'] },
    { name: 'cross-codebase revoke update', sql: revokeSql, params: ['user-1', 'now', 'now', 'codebase-2', 'session-2'] },
    // The pre-fix, unscoped revoke that reproduced the live failure.
    {
      name: 'unscoped revoke update',
      sql: "update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ? where session_id = ?",
      params: ['user-1', 'now', 'now', 'session-2'],
    },
  ]
  for (const statement of rejected) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session SQL must be constrained to its codebase/,
      statement.name,
    )
  }
})

test('write-only scoped session cannot revoke another agent session', () => {
  const session = scopedSession({ capabilities_json: JSON.stringify(['write']) })
  assert.throws(
    () => assertScopedSessionStatementAllowed(session, {
      sql: `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
        where codebase_id = ? and session_id = ?`,
      params: ['user-1', 'now', 'now', 'codebase-1', 'session-2'],
    }),
    /admin capability/,
  )
})

// The exact statement shapes @hopit/backend-d1 episodes-store.js issues for
// trail summaries. Kept verbatim so a drive-by SQL change over there fails
// here before it fails on the deployed worker (the trail_episodes launch bug).
const trailEpisodeSelectSql = 'select * from trail_episodes where codebase_id = ? order by from_revision asc'
const codebaseSettingsSelectSql = 'select * from codebase_settings where codebase_id = ? limit 1'
const trailEpisodeUpsertSql = `insert into trail_episodes (
  codebase_id, episode_id, from_revision, to_revision, device,
  started_at, ended_at, step_count, changed_path_count, sample_paths_json,
  label, label_model, label_mode, created_at, updated_at
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict(codebase_id, episode_id) do update set
  from_revision = excluded.from_revision,
  to_revision = excluded.to_revision,
  device = excluded.device,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at,
  step_count = excluded.step_count,
  changed_path_count = excluded.changed_path_count,
  sample_paths_json = excluded.sample_paths_json,
  label = excluded.label,
  label_model = excluded.label_model,
  label_mode = excluded.label_mode,
  updated_at = excluded.updated_at`
const codebaseSettingsUpsertSql = `insert into codebase_settings (
  codebase_id, trail_summaries_enabled, trail_summaries_mode, created_at, updated_at
) values (?, ?, ?, ?, ?)
on conflict(codebase_id) do update set
  trail_summaries_enabled = excluded.trail_summaries_enabled,
  trail_summaries_mode = excluded.trail_summaries_mode,
  updated_at = excluded.updated_at`

function trailEpisodeUpsertParams(codebaseId) {
  return [codebaseId, 'ep_1_3', 1, 3, 'Laptop', 'now', 'now', 3, 2, '["src/a.js"]', 'label', 'stub', 'metadata', 'now', 'now']
}

test('scoped SQL policy accepts codebase-scoped trail-episode reads and writes', () => {
  const session = scopedSession()
  const accepted = [
    { sql: trailEpisodeSelectSql, params: ['codebase-1'] },
    { sql: trailEpisodeUpsertSql, params: trailEpisodeUpsertParams('codebase-1') },
    { sql: codebaseSettingsSelectSql, params: ['codebase-1'] },
    { sql: codebaseSettingsUpsertSql, params: ['codebase-1', 1, 'metadata', 'now', 'now'] },
  ]
  for (const statement of accepted) {
    assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, statement), statement.sql)
  }

  // The launch failure: `hop trail episodes` only needs read capability.
  const readOnly = scopedSession({ capabilities_json: JSON.stringify(['read']) })
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(readOnly, { sql: trailEpisodeSelectSql, params: ['codebase-1'] }))
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(readOnly, { sql: codebaseSettingsSelectSql, params: ['codebase-1'] }))

  // Episode labels are ordinary work data: write capability suffices.
  const writer = scopedSession({ capabilities_json: JSON.stringify(['read', 'write']) })
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(writer, { sql: trailEpisodeUpsertSql, params: trailEpisodeUpsertParams('codebase-1') }))
})

test('scoped SQL policy rejects cross-codebase and unscoped trail statements', () => {
  const session = scopedSession()
  const rejected = [
    { name: 'cross-codebase episode read', sql: trailEpisodeSelectSql, params: ['codebase-2'] },
    { name: 'cross-codebase episode upsert', sql: trailEpisodeUpsertSql, params: trailEpisodeUpsertParams('codebase-2') },
    { name: 'cross-codebase settings read', sql: codebaseSettingsSelectSql, params: ['codebase-2'] },
    { name: 'cross-codebase settings upsert', sql: codebaseSettingsUpsertSql, params: ['codebase-2', 1, 'diff', 'now', 'now'] },
    { name: 'unscoped episode read', sql: 'select * from trail_episodes', params: [] },
    { name: 'unscoped episode delete', sql: 'delete from trail_episodes where episode_id = ?', params: ['ep_1_3'] },
    { name: 'unscoped settings read', sql: 'select * from codebase_settings', params: [] },
    { name: 'unscoped settings update', sql: 'update codebase_settings set trail_summaries_enabled = ? where trail_summaries_mode = ?', params: [1, 'metadata'] },
    {
      name: 'settings conflict target without codebase scope',
      sql: 'insert into codebase_settings (codebase_id, trail_summaries_enabled, trail_summaries_mode, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(trail_summaries_mode) do update set updated_at = excluded.updated_at',
      params: ['codebase-1', 1, 'metadata', 'now', 'now'],
    },
  ]
  for (const statement of rejected) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }
})

test('codebase_settings writes require admin capability; write-only sessions are refused', () => {
  const writer = scopedSession({ capabilities_json: JSON.stringify(['read', 'write']) })
  assert.throws(
    () => assertScopedSessionStatementAllowed(writer, {
      sql: codebaseSettingsUpsertSql,
      params: ['codebase-1', 1, 'diff', 'now', 'now'],
    }),
    /admin capability/,
  )
  assert.throws(
    () => assertScopedSessionStatementAllowed(writer, {
      sql: 'update codebase_settings set trail_summaries_enabled = ?, updated_at = ? where codebase_id = ?',
      params: [1, 'now', 'codebase-1'],
    }),
    /admin capability/,
  )

  const admin = scopedSession({ capabilities_json: JSON.stringify(['read', 'write', 'admin']) })
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(admin, {
    sql: codebaseSettingsUpsertSql,
    params: ['codebase-1', 1, 'diff', 'now', 'now'],
  }))
})

test('guarded journal head policy preserves Main and selected-state security fields', () => {
  const session = scopedSession({ capabilities_json: JSON.stringify(['write']) })
  const previousSelected = { type: 'active-change-set', id: 'cs_1', revision: 1, effectiveVisibility: 'private', mergeState: 'unmerged' }
  const nextSelected = { ...previousSelected, revision: 2 }
  const main = { id: 'main', revision: 1 }
  const sql = 'update codebases set revision = ?, selected_state_json = ?, main_json = ?, file_count = ?, private_file_count = ?, updated_at = ? where codebase_id = ? and revision = ? and selected_state_json = ? and main_json = ?'
  const baseParams = [2, JSON.stringify(nextSelected), JSON.stringify(main), 1, 0, 'now', 'codebase-1', 1, JSON.stringify(previousSelected), JSON.stringify(main)]
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, { sql, params: baseParams }))
  assert.throws(
    () => assertScopedSessionStatementAllowed(session, {
      sql,
      params: [
        ...baseParams.slice(0, 1),
        JSON.stringify({ ...nextSelected, effectiveVisibility: 'team-visible' }),
        ...baseParams.slice(2),
      ],
    }),
    /may only advance selected-state revision/,
  )
  assert.throws(
    () => assertScopedSessionStatementAllowed(session, {
      sql,
      params: [...baseParams.slice(0, 2), JSON.stringify({ ...main, revision: 2 }), ...baseParams.slice(3)],
    }),
    /must preserve Main/,
  )
  const mainSelected = { type: 'main', id: 'main', revision: 1, mergeState: 'unmerged' }
  assert.throws(
    () => assertScopedSessionStatementAllowed(session, {
      sql,
      params: [2, JSON.stringify({ ...mainSelected, revision: 2 }), JSON.stringify(main), 1, 0, 'now', 'codebase-1', 1, JSON.stringify(mainSelected), JSON.stringify(main)],
    }),
    /same active change set/,
  )
  const mergedSelected = { type: 'active-change-set', id: 'cs_1', revision: 1, mergeState: 'merged' }
  assert.throws(
    () => assertScopedSessionStatementAllowed(session, {
      sql,
      params: [2, JSON.stringify({ ...mergedSelected, revision: 2 }), JSON.stringify(main), 1, 0, 'now', 'codebase-1', 1, JSON.stringify(mergedSelected), JSON.stringify(main)],
    }),
    /unmerged change set/,
  )
})

// --- Adversarial cross-tenant isolation matrix -------------------------------
// Threat model: an agent session scoped to codebase A ("codebase-1") must never
// be able to read or write ANY codebase-scoped table for codebase B
// ("codebase-2") through the raw-SQL proxy policy. The session below carries the
// FULL capability set (including admin) so that every rejection below is proven
// to come from the cross-tenant scope guard, not from a missing capability.

// Every entry of `codebaseScopedTables` in scoped-sql.js. Kept as a literal list
// so a new scoped table added there without a cross-tenant test here shows up as
// a coverage gap.
const crossTenantScopedTables = [
  'codebases',
  'files',
  'file_versions',
  'file_blobs',
  'agent_events',
  'action_jobs',
  'collaboration_counters',
  'issues',
  'issue_comments',
  'projects',
  'project_items',
  'discussions',
  'discussion_comments',
  'releases',
  'release_assets',
  'review_threads',
  'review_thread_comments',
  'review_decisions',
  'notifications',
  'codebase_members',
  'codebase_invitations',
  'agent_sessions',
  'codebase_keyrings',
  'wrapped_keys',
  'key_audit_events',
  'trail_episodes',
  'codebase_settings',
]

// A read shape that is VALID when scoped to the session's own codebase, so the
// only thing that changes between the "own" and "cross-tenant" params is the
// codebase id. This isolates the scope guard as the cause of rejection.
function crossTenantReadStatement(table, codebaseId) {
  if (table === 'files') {
    return { sql: 'select * from files where codebase_id = ?', params: [codebaseId] }
  }
  if (table === 'file_versions') {
    return {
      sql: 'select * from file_versions where codebase_id = ? order by graph_revision asc, version_id asc',
      params: [codebaseId],
    }
  }
  if (table === 'file_blobs') {
    return {
      sql: 'select content, encoding, size from file_blobs where codebase_id = ? and hash = ? limit 1',
      params: [codebaseId, 'a'.repeat(64)],
    }
  }
  return { sql: `select * from ${table} where codebase_id = ?`, params: [codebaseId] }
}

// A destructive write shape (DELETE) that is likewise valid for the own codebase
// under an admin session, so cross-tenant rejection is proven to be the scope
// guard rather than a capability or shape failure.
function crossTenantDeleteStatement(table, codebaseId) {
  return { sql: `delete from ${table} where codebase_id = ?`, params: [codebaseId] }
}

test('scoped SQL policy accepts every codebase-scoped read/delete for the session own codebase (baseline)', () => {
  const session = scopedSession()
  for (const table of crossTenantScopedTables) {
    assert.doesNotThrow(
      () => assertScopedSessionStatementAllowed(session, crossTenantReadStatement(table, 'codebase-1')),
      `own-codebase read of ${table} should be allowed`,
    )
    assert.doesNotThrow(
      () => assertScopedSessionStatementAllowed(session, crossTenantDeleteStatement(table, 'codebase-1')),
      `own-codebase delete of ${table} should be allowed`,
    )
  }
})

test('scoped SQL policy rejects cross-tenant READS of every codebase-scoped table', () => {
  const session = scopedSession()
  for (const table of crossTenantScopedTables) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, crossTenantReadStatement(table, 'codebase-2')),
      /Scoped agent session/,
      `cross-tenant read of ${table} must be rejected`,
    )
  }
})

test('scoped SQL policy rejects cross-tenant WRITES (delete) of every codebase-scoped table', () => {
  const session = scopedSession()
  for (const table of crossTenantScopedTables) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, crossTenantDeleteStatement(table, 'codebase-2')),
      /Scoped agent session/,
      `cross-tenant delete of ${table} must be rejected`,
    )
  }
})

test('scoped SQL policy rejects cross-tenant INSERT and UPDATE targeting another codebase', () => {
  const session = scopedSession()
  const rejected = [
    {
      name: 'insert into another codebase',
      sql: 'insert into issues (codebase_id, issue_id, number, title) values (?, ?, ?, ?)',
      params: ['codebase-2', 'issue_1', 1, 'smuggled'],
    },
    {
      name: 'update another codebase row',
      sql: 'update issues set title = ? where codebase_id = ?',
      params: ['pwned', 'codebase-2'],
    },
    {
      name: 'insert agent_events for another codebase',
      sql: 'insert into agent_events (codebase_id, event, detail_json) values (?, ?, ?)',
      params: ['codebase-2', 'file.mutated', '{}'],
    },
    {
      name: 'update notifications for another codebase',
      sql: 'update notifications set read_at = ? where codebase_id = ?',
      params: ['now', 'codebase-2'],
    },
  ]
  for (const statement of rejected) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }

  // The matching own-codebase writes are accepted, proving the rejection above is
  // the cross-tenant scope guard and not the shape or capability policy.
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, {
    sql: 'insert into issues (codebase_id, issue_id, number, title) values (?, ?, ?, ?)',
    params: ['codebase-1', 'issue_1', 1, 'legit'],
  }))
  assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, {
    sql: 'update issues set title = ? where codebase_id = ?',
    params: ['legit', 'codebase-1'],
  }))
})

test('scoped SQL policy rejects codebase-id smuggling with a second predicate clause', () => {
  const session = scopedSession()
  // Statement scoped to codebase-1 in one predicate but reading codebase-2 in a
  // second predicate clause (and the reverse ordering). Every codebase_id = ?
  // predicate must equal the session codebase, so neither ordering leaks.
  const smuggles = [
    { name: 'own-then-other', params: ['codebase-1', 'codebase-2'] },
    { name: 'other-then-own', params: ['codebase-2', 'codebase-1'] },
  ]
  for (const { name, params } of smuggles) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, {
        sql: 'select * from issues where codebase_id = ? and codebase_id = ?',
        params,
      }),
      /constrained to its codebase/,
      name,
    )
  }
})

test('scoped SQL policy rejects statements with no codebase constraint at all', () => {
  const session = scopedSession()
  const unconstrained = [
    { name: 'select without where', sql: 'select * from issues', params: [] },
    { name: 'select on non-codebase predicate', sql: 'select * from issues where issue_id = ?', params: ['issue_1'] },
    { name: 'delete without codebase predicate', sql: 'delete from notifications where read_at = ?', params: ['now'] },
    { name: 'update without codebase predicate', sql: 'update issues set title = ? where issue_id = ?', params: ['x', 'issue_1'] },
    { name: 'unknown table with codebase predicate', sql: 'select * from secrets where codebase_id = ?', params: ['codebase-1'] },
  ]
  for (const statement of unconstrained) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }
})

test('scoped SQL policy rejects cross-tenant JOIN, UNION, and subquery escapes', () => {
  const session = scopedSession()
  const escapes = [
    {
      name: 'cross-tenant union',
      sql: 'select * from issues where codebase_id = ? union select * from issues where codebase_id = ?',
      params: ['codebase-1', 'codebase-2'],
    },
    {
      name: 'cross-tenant subquery',
      sql: 'select * from issues where codebase_id = ? and issue_id in (select issue_id from issues where codebase_id = ?)',
      params: ['codebase-1', 'codebase-2'],
    },
    {
      name: 'cross-tenant join',
      sql: 'select other.* from issues own join issues other on own.number = other.number where own.codebase_id = ?',
      params: ['codebase-1'],
    },
    {
      name: 'cross-tenant table list',
      sql: 'select a.* from issues a, issues b where a.codebase_id = ? and b.codebase_id = ?',
      params: ['codebase-1', 'codebase-2'],
    },
  ]
  for (const statement of escapes) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }
})

test('failed auth attempts are rate limited per client ip', async () => {
  const logs = []
  const originalLog = console.log
  console.log = (message) => logs.push(String(message))
  try {
    let response
    for (let attempt = 0; attempt < 21; attempt += 1) {
      response = await worker.fetch(new Request('https://worker.example/query', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
          'x-hopit-codebase-id': 'codebase-1',
          'cf-connecting-ip': '203.0.113.12',
        },
        body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] }),
      }), {
        HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
        HOPIT_D1_DB: createMockDb(),
      })
    }

    assert.equal(response.status, 429)
    const lastLog = JSON.parse(logs.at(-1))
    assert.equal(lastLog.status, 429)
    assert.equal(lastLog.rejectedReason, 'failed-auth-rate-limit')
    assert.equal(logs.some((line) => line.includes('wrong-token')), false)
  } finally {
    console.log = originalLog
  }
})

test('non-query requests are logged as rejected requests', async () => {
  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/other', {
      headers: { 'cf-connecting-ip': '203.0.113.13' },
    }), { HOPIT_D1_DB: createMockDb() })

    assert.equal(response.status, 404)
  })

  const log = JSON.parse(logs[0])
  assert.equal(log.status, 404)
  assert.equal(log.rejectedReason, 'not-found')
  assert.equal(log.statementCount, 0)
})

test('authenticated WebSocket upgrade is routed to the codebase Durable Object', async () => {
  const namespace = createMockPushNamespace()
  const response = await worker.fetch(new Request('https://worker.example/events?codebaseId=codebase-1&selectedStateId=cs_1', {
    headers: {
      upgrade: 'websocket',
      authorization: 'Bearer proxy-secret',
      'cf-connecting-ip': '203.0.113.14',
    },
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: createMockDb(),
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(namespace.idNames, ['codebase-1'])
  assert.equal(namespace.fetches.length, 1)
  assert.equal(new URL(namespace.fetches[0].request.url).searchParams.get('codebaseId'), 'codebase-1')
})

test('unauthenticated WebSocket upgrade is rejected before Durable Object routing', async () => {
  const namespace = createMockPushNamespace()
  const response = await worker.fetch(new Request('https://worker.example/events?codebaseId=codebase-1', {
    headers: {
      upgrade: 'websocket',
      'cf-connecting-ip': '203.0.113.15',
    },
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: createMockDb(),
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 403)
  assert.equal(namespace.fetches.length, 0)
})

test('Durable Object hub fans out envelopes and persists the cursor for stale reconnects', async () => {
  const state = createMockDurableObjectState()
  const hub = new CodebasePushHub(state, {})
  const socketA = createMockSocket()
  const socketB = createMockSocket()

  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), socketA)
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), socketB)
  const response = await hub.notify({
    type: 'codebase.remote_update',
    codebaseId: 'codebase-1',
    selectedStateId: 'cs_1',
    revision: 2,
    eventId: 'evt_2',
    changedPaths: ['README.md'],
    scopeCounts: { shared: 1, private: 0 },
  })

  assert.equal(response.status, 200)
  assert.equal(socketA.sent.length, 1)
  assert.equal(socketB.sent.length, 1)
  const cursor = await state.storage.get('last-cursor')
  assert.equal(cursor.eventId, 'evt_2')
  assert.equal(cursor.revision, 2)
  assert.match(cursor.updatedAt, /\d{4}-/)

  const staleSocket = createMockSocket()
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), staleSocket)
  assert.equal(staleSocket.sent.length, 1)
  assert.equal(JSON.parse(staleSocket.sent[0]).eventId, 'evt_2')

  const freshSocket = createMockSocket()
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastEventId=evt_2&lastRevision=2'), freshSocket)
  assert.equal(freshSocket.sent.length, 0)
})

test('successful graph mutation emits a compact push envelope after commit', async () => {
  const namespace = createMockPushNamespace()
  const db = createMockDb({
    codebase: {
      codebase_id: 'codebase-1',
      revision: 2,
      selected_state_json: JSON.stringify({ id: 'cs_1' }),
    },
    files: [
      { path: 'README.md', scope: 'shared', revision: 2 },
      { path: '.private/notes.md', scope: 'owner-private', revision: 2 },
    ],
  })

  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.16',
    },
    body: JSON.stringify({ sql: 'update codebases set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] }),
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: db,
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.equal(namespace.notifications.length, 1)
  const envelope = namespace.notifications[0]
  assert.equal(envelope.type, 'codebase.remote_update')
  assert.equal(envelope.codebaseId, 'codebase-1')
  assert.equal(envelope.selectedStateId, 'cs_1')
  assert.equal(envelope.revision, 2)
  assert.deepEqual(envelope.changedPaths, ['README.md'])
  assert.deepEqual(envelope.scopeCounts, { shared: 1, private: 1 })
  assert.equal(Object.hasOwn(envelope, 'files'), false)
  assert.equal(Object.hasOwn(envelope, 'bytes'), false)
})

test('team-visible collaborator accepts canonical guarded shared-file commit and emits one push envelope', async () => {
  const namespace = createMockPushNamespace()
  const previousSelectedState = {
    type: 'active-change-set',
    id: 'cs_1',
    revision: 1,
    effectiveVisibility: 'team-visible',
    mergeState: 'unmerged',
  }
  const nextSelectedState = { ...previousSelectedState, revision: 2 }
  const main = { id: 'main', revision: 1 }
  const db = createMockDb({
    session: {
      session_id: 'session-1',
      user_id: 'user-member',
      codebase_id: 'codebase-1',
      status: 'active',
      expires_at: null,
      capabilities_json: JSON.stringify(['read', 'write']),
    },
    codebase: {
      codebase_id: 'codebase-1',
      owner_id: 'user-owner',
      revision: 2,
      selected_state_json: JSON.stringify(nextSelectedState),
      visibility_json: JSON.stringify({ effective: 'team-visible' }),
    },
    membership: { role: 'member', status: 'active' },
    files: [{ path: 'README.md', scope: 'shared', revision: 2 }],
  })

  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.18',
    },
    body: JSON.stringify([
      {
        sql: 'update codebases set revision = ?, selected_state_json = ?, main_json = ?, file_count = ?, private_file_count = ?, updated_at = ? where codebase_id = ? and revision = ? and selected_state_json = ? and main_json = ?',
        params: [
          2,
          JSON.stringify(nextSelectedState),
          JSON.stringify(main),
          1,
          0,
          '2026-07-08T00:00:00.000Z',
          'codebase-1',
          1,
          JSON.stringify(previousSelectedState),
          JSON.stringify(main),
        ],
      },
      {
        sql: `insert into files (
          codebase_id, path, kind, content, encoding, target, blob_hash, blob_provider,
          blob_key, blob_size, client_encryption_json, encryption_json, privacy_zone,
          zone_id, content_storage, hash, size, scope, revision, updated_at
        ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        where exists (
          select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?
        )
        on conflict(codebase_id, path) do update set
          kind = excluded.kind,
          content = excluded.content,
          encoding = excluded.encoding,
          target = excluded.target,
          blob_hash = excluded.blob_hash,
          blob_provider = excluded.blob_provider,
          blob_key = excluded.blob_key,
          blob_size = excluded.blob_size,
          client_encryption_json = excluded.client_encryption_json,
          encryption_json = excluded.encryption_json,
          privacy_zone = excluded.privacy_zone,
          zone_id = excluded.zone_id,
          content_storage = excluded.content_storage,
          hash = excluded.hash,
          size = excluded.size,
          scope = excluded.scope,
          revision = excluded.revision,
          updated_at = excluded.updated_at`,
        params: ['codebase-1', 'README.md', 'file', 'changed', 'utf8', null, null, null, null, null, null, null, 'repo-content', 'codebase-1:repo-content', 'inline', 'hash', 7, 'shared', 2, '2026-07-08T00:00:00.000Z', 'codebase-1', 2, '2026-07-08T00:00:00.000Z'],
      },
      {
        sql: 'insert into file_versions (codebase_id, selected_state_type, selected_state_id, main_state_id, graph_revision, path, operation, kind, old_revision, new_revision, old_file_json, new_file_json, scope, privacy_zone, zone_id, content_storage, blob_provider, blob_key, blob_hash, encoding, target, size, actor_user_id, session_id, device_name, created_at) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? where exists (select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?)',
        params: ['codebase-1', 'active-change-set', 'cs_1', 'main', 2, 'README.md', 'modify', 'file', 1, 2, '{}', '{}', 'shared', 'repo-content', 'codebase-1:repo-content', 'inline', null, null, null, 'utf8', null, 7, 'user-1', 'session-1', 'test', '2026-07-08T00:00:00.000Z', 'codebase-1', 2, '2026-07-08T00:00:00.000Z'],
      },
    ]),
  }), {
    HOPIT_D1_DB: db,
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.equal(db.sessionLookups, 1)
  assert.equal(db.executedStatements.length, 3)
  assert.equal(namespace.notifications.length, 1)
  assert.equal(namespace.notifications[0].codebaseId, 'codebase-1')
  assert.deepEqual(namespace.notifications[0].changedPaths, ['README.md'])
})

test('collaborator cannot write a shared file while the active change set is private', async () => {
  const states = journalSelectedStates('private')
  const db = createScopedMutationDb(states.previous, 'private')
  const response = await worker.fetch(scopedQueryRequest(
    guardedJournalBatch({ path: 'README.md', previousSelectedState: states.previous, nextSelectedState: states.next }),
    '203.0.113.43',
  ), { HOPIT_D1_DB: db })

  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /private active change set/)
  assert.equal(db.executedStatements.length, 0)
})

test('collaborator cannot create, update, or delete owner-private paths through canonical journal SQL', async () => {
  const states = journalSelectedStates('team-visible')
  const attempts = [
    { label: 'create', operation: 'write', path: '.private/new.txt' },
    { label: 'update', operation: 'write', path: '.private/existing.txt' },
    { label: 'delete', operation: 'delete', path: '.private/existing.txt' },
  ]

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]
    const db = createScopedMutationDb(states.previous, 'team-visible')
    const response = await worker.fetch(scopedQueryRequest(
      guardedJournalBatch({
        path: attempt.path,
        operation: attempt.operation,
        previousSelectedState: states.previous,
        nextSelectedState: states.next,
      }),
      `203.0.113.${44 + index}`,
    ), { HOPIT_D1_DB: db })

    assert.equal(response.status, 403, attempt.label)
    assert.match((await response.json()).errors[0].message, /owner-private paths/, attempt.label)
    assert.equal(db.executedStatements.length, 0, attempt.label)
  }
})

test('push notify failure is logged without failing the committed mutation', async () => {
  const namespace = createMockPushNamespace({ notifyStatus: 503 })
  const db = createMockDb({
    codebase: {
      codebase_id: 'codebase-1',
      revision: 3,
      selected_state_json: JSON.stringify({ id: 'cs_1' }),
    },
    files: [{ path: 'README.md', scope: 'shared', revision: 3 }],
  })

  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.17',
      },
      body: JSON.stringify({ sql: 'update files set revision = ? where codebase_id = ?', params: [3, 'codebase-1'] }),
    }), {
      HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
      HOPIT_D1_DB: db,
      HOPIT_PUSH_HUB: namespace,
    })

    assert.equal(response.status, 200)
  })

  assert.ok(logs.some((line) => JSON.parse(line).event === 'hopit.d1.proxy.push_notify_failed'))
})

test('multi-statement mutations use one atomic D1 batch', async () => {
  const db = createAtomicBatchDb()
  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.30',
    },
    body: JSON.stringify([
      { sql: 'update codebases set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] },
      { sql: 'update files set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] },
    ]),
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: db,
  })

  assert.equal(response.status, 200)
  assert.equal(db.batchCalls, 1)
  assert.deepEqual(db.state, { codebaseRevision: 2, fileRevision: 2 })
  assert.equal((await response.json()).result.length, 2)
})

test('failed D1 batches roll back earlier mutation statements', async () => {
  const db = createAtomicBatchDb({ failAt: 1 })
  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.31',
    },
    body: JSON.stringify([
      { sql: 'update codebases set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] },
      { sql: 'update files set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] },
    ]),
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: db,
  })

  assert.equal(response.status, 400)
  assert.equal(db.batchCalls, 1)
  assert.deepEqual(db.state, { codebaseRevision: 1, fileRevision: 1 })
  assert.match((await response.json()).errors[0].message, /synthetic batch failure/)
})

// ---------------------------------------------------------------------------
// Adversarial cross-tenant isolation (Phase 3 Stage-0)
//
// Two distinct owners: user-a owns codebase-a, user-b owns codebase-b. Every
// case below acts under user-b's scoped session (scoped to codebase-b) and
// targets user-a's codebase-a across every scoped table. The property under
// test: a scoped session can NEVER read, write, upsert, or delete another
// tenant's rows, even when the SQL is a byte-for-byte copy of the victim's own
// legitimate statement. "Their data is provably isolated" as a tested property.
// ---------------------------------------------------------------------------

function crossTenantSession(overrides = {}) {
  // user-b, scoped to codebase-b, with every capability. Full capabilities
  // ensure a rejection is the tenant boundary talking, not a missing grant.
  return scopedSession({
    session_id: 'session-b',
    user_id: 'user-b',
    codebase_id: 'codebase-b',
    ...overrides,
  })
}

// The victim's own legitimate statements, parametrized by codebase. Passing
// 'codebase-a' makes each one a cross-tenant attack under user-b's session;
// passing 'codebase-b' makes it a same-tenant control that must be accepted.
function victimStatements(codebaseId) {
  return [
    { table: 'files read', sql: 'select * from files where codebase_id = ?', params: [codebaseId] },
    {
      table: 'files guarded delete',
      sql: `delete from files where codebase_id = ? and path = ? and exists (
        select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?
      )`,
      params: [codebaseId, 'README.md', codebaseId, 2, '2026-07-10T00:00:00.000Z'],
    },
    {
      table: 'file_versions read',
      sql: 'select * from file_versions where codebase_id = ? order by graph_revision asc, version_id asc',
      params: [codebaseId],
    },
    { table: 'agent_events read', sql: 'select * from agent_events where codebase_id = ?', params: [codebaseId] },
    {
      table: 'agent_events insert',
      sql: 'insert into agent_events (codebase_id, event, detail_json, at) values (?, ?, ?, ?)',
      params: [codebaseId, 'exfiltrate', '{}', 'now'],
    },
    { table: 'trail_episodes read', sql: trailEpisodeSelectSql, params: [codebaseId] },
    { table: 'trail_episodes upsert', sql: trailEpisodeUpsertSql, params: trailEpisodeUpsertParams(codebaseId) },
    { table: 'codebase_settings read', sql: codebaseSettingsSelectSql, params: [codebaseId] },
    {
      table: 'codebase_settings upsert',
      sql: codebaseSettingsUpsertSql,
      params: [codebaseId, 1, 'diff', 'now', 'now'],
    },
    {
      table: 'agent_sessions read',
      sql: 'select * from agent_sessions where codebase_id = ? and session_id = ? limit 1',
      params: [codebaseId, 'session-a'],
    },
    {
      table: 'agent_sessions revoke',
      sql: `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
        where codebase_id = ? and session_id = ?`,
      params: ['user-b', 'now', 'now', codebaseId, 'session-a'],
    },
    { table: 'codebase_members read', sql: 'select * from codebase_members where codebase_id = ?', params: [codebaseId] },
    {
      table: 'codebase_members insert',
      sql: 'insert into codebase_members (codebase_id, user_id, role, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      params: [codebaseId, 'user-b', 'owner', 'active', 'now', 'now'],
    },
    { table: 'issues read', sql: 'select * from issues where codebase_id = ?', params: [codebaseId] },
    {
      table: 'issues insert',
      sql: 'insert into issues (codebase_id, issue_id, number, title, status, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [codebaseId, 'iss_1', 1, 'planted', 'open', 'user-b', 'now', 'now'],
    },
    { table: 'discussions read', sql: 'select * from discussions where codebase_id = ?', params: [codebaseId] },
    { table: 'releases read', sql: 'select * from releases where codebase_id = ?', params: [codebaseId] },
    {
      table: 'releases insert',
      sql: 'insert into releases (codebase_id, release_id, number, version, title, notes, status, target_json, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [codebaseId, 'rel_1', 1, '1.0.0', 'planted', 'notes', 'draft', '{}', 'user-b', 'now', 'now'],
    },
  ]
}

test('cross-tenant: user-b session cannot touch user-a rows on any scoped table', () => {
  const session = crossTenantSession()
  for (const statement of victimStatements('codebase-a')) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session SQL must be constrained to its codebase/,
      statement.table,
    )
  }
})

test('cross-tenant control: the identical statements are accepted for the session own codebase', () => {
  // Proves the matrix above rejects on tenant boundary, not on SQL shape: the
  // very same statement shapes pass when re-scoped to codebase-b.
  const session = crossTenantSession()
  for (const statement of victimStatements('codebase-b')) {
    assert.doesNotThrow(() => assertScopedSessionStatementAllowed(session, statement), statement.table)
  }
})

test('cross-tenant: sneaky SQL shapes reaching user-a rows are all rejected', () => {
  const session = crossTenantSession()
  const hostile = [
    { name: 'or clause across tenants', sql: 'select * from files where codebase_id = ? or codebase_id = ?', params: ['codebase-b', 'codebase-a'] },
    { name: 'in list across tenants', sql: 'select * from agent_events where codebase_id in (?, ?)', params: ['codebase-b', 'codebase-a'] },
    { name: 'subquery touching victim rows', sql: 'delete from agent_events where codebase_id = ? and id in (select id from agent_events where codebase_id = ?)', params: ['codebase-b', 'codebase-a'] },
    { name: 'union to victim rows', sql: 'select * from files where codebase_id = ? union select * from files where codebase_id = ?', params: ['codebase-b', 'codebase-a'] },
    { name: 'missing codebase constraint (unscoped read)', sql: 'select * from agent_events', params: [] },
    { name: 'unscoped delete (no where)', sql: 'delete from agent_events', params: [] },
    { name: 'unscoped update (no where)', sql: 'update trail_episodes set label = ?', params: ['pwned'] },
    { name: 'victim predicate with own-tenant decoy param', sql: 'delete from agent_events where codebase_id = ? and source = ?', params: ['codebase-a', 'codebase-b'] },
    { name: 'insert planting a victim row', sql: 'insert into agent_events (codebase_id, event, detail_json, at) values (?, ?, ?, ?)', params: ['codebase-a', 'x', '{}', 'now'] },
    { name: 'cross-tenant conflict target', sql: 'insert into files (codebase_id, path, content) values (?, ?, ?) on conflict(path) do update set content = excluded.content', params: ['codebase-a', 'README.md', 'body'] },
    { name: 'line comment hiding victim scope', sql: 'select * from files where codebase_id = ? -- codebase-b', params: ['codebase-a'] },
    { name: 'stacked statement targeting victim', sql: 'select * from files where codebase_id = ?; delete from files where codebase_id = ?', params: ['codebase-b', 'codebase-a'] },
    { name: 'not-equal codebase predicate', sql: 'select * from agent_events where codebase_id <> ?', params: ['codebase-b'] },
  ]
  for (const statement of hostile) {
    assert.throws(
      () => assertScopedSessionStatementAllowed(session, statement),
      /Scoped agent session/,
      statement.name,
    )
  }
})

test('cross-tenant: Worker refuses a victim-scoped statement under user-b session before execution', async () => {
  const db = createMockDb({ session: crossTenantSession() })
  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      // Header matches the session codebase, so this passes the codebase-scope
      // header check and the rejection can only come from the statement policy.
      'x-hopit-codebase-id': 'codebase-b',
      'cf-connecting-ip': '203.0.113.60',
    },
    body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] }),
  }), { HOPIT_D1_DB: db })

  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /must be constrained to its codebase/)
  assert.equal(db.executedStatements.length, 0)
})

test('cross-tenant: Worker rejects a session whose header claims another tenant codebase', async () => {
  const db = createMockDb({ session: crossTenantSession() })
  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-a',
      'cf-connecting-ip': '203.0.113.61',
    },
    body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] }),
  }), { HOPIT_D1_DB: db })

  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /not scoped to the requested codebase/)
  assert.equal(db.executedStatements.length, 0)
})

test('cross-tenant control: user-b session executes against its own codebase', async () => {
  const db = createMockDb({ session: crossTenantSession() })
  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-b',
      'cf-connecting-ip': '203.0.113.62',
    },
    body: JSON.stringify({ sql: 'select * from agent_events where codebase_id = ?', params: ['codebase-b'] }),
  }), { HOPIT_D1_DB: db })

  assert.equal(response.status, 200)
  assert.equal(db.executedStatements.length, 1)
  assert.deepEqual(db.executedStatements[0].params, ['codebase-b'])
})

// ---------------------------------------------------------------------------
// Server-actor tier (Phase 3 Stage 1a: HOPIT_MULTITENANT / Front 1)
//
// The hosted dashboard historically reached D1 with the omnipotent proxy token,
// which skips all scoping. Behind HOPIT_MULTITENANT, the dashboard instead
// presents a per-request `hsa_` server-actor token carrying the authenticated
// user id. The Worker re-derives that id (HMAC) and refuses any statement that
// touches a codebase the user neither owns nor is an active member of: while
// still allowing a user to list THEIR OWN multiple codebases. Proxy and hst_
// behavior must be identical whether the flag is on or off.
// ---------------------------------------------------------------------------

const SERVER_ACTOR_SECRET = 'server-actor-secret'

function mintTestServerActorToken({ userId, secret = SERVER_ACTOR_SECRET, ttlMs = 60_000, now = Date.now() }) {
  const payload = { u: userId, iat: now, exp: now + ttlMs }
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payloadPart).digest('base64url')
  return `hsa_${payloadPart}.${signature}`
}

// A codebase-entitlement fixture: maps codebaseId -> { ownerId, members: {userId: status} }
// and answers both the Worker's per-codebase entitlement lookup and the executed
// statements. `member_user_id` in the projected columns marks the entitlement query.
function createServerActorDb({ codebases = {} } = {}) {
  const db = {
    executedStatements: [],
    prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind(...params) {
          return {
            async all() {
              if (normalized.includes('from codebases c') && normalized.includes('member_user_id')) {
                const [userId, codebaseId] = params
                const entry = codebases[codebaseId]
                if (!entry) return { results: [] }
                const memberStatus = entry.members?.[userId] ?? null
                return {
                  results: [{
                    owner_id: entry.ownerId ?? null,
                    member_user_id: memberStatus ? userId : null,
                    member_status: memberStatus,
                  }],
                }
              }
              db.executedStatements.push({ sql, params })
              return { results: [], meta: { duration: 1 } }
            },
          }
        },
      }
    },
  }
  return db
}

function serverActorRequest({ token, body, ip, codebaseId = 'codebase-a' }) {
  return new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-hopit-codebase-id': codebaseId,
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  })
}

const multiTenantEnv = (extra = {}) => ({
  HOPIT_MULTITENANT: '1',
  HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
  HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
  ...extra,
})

function serverActorCreateCodebaseStatement({ codebaseId = 'codebase-new', ownerId = 'user-a', upsert = false } = {}) {
  return {
    sql: `insert into codebases (codebase_id, name, owner_id) values (?, ?, ?)${upsert ? ' on conflict(codebase_id) do update set owner_id = excluded.owner_id' : ''}`,
    params: [codebaseId, 'New codebase', ownerId],
  }
}

test('server-actor static policy: own vs cross-tenant, listing, and deny-by-default', () => {
  const actor = { userId: 'user-a' }
  // Codebase-anchored read the actor is (statically) allowed to name.
  assert.doesNotThrow(() => assertServerActorStatementAllowed(actor, {
    sql: 'select * from files where codebase_id = ?',
    params: ['codebase-a'],
  }))
  // A cross-codebase LISTING scoped to the actor's own user id is allowed
  // (user reading THEIR OWN codebases), even with no codebase_id predicate.
  assert.doesNotThrow(() => assertServerActorStatementAllowed(actor, {
    sql: `select distinct c.* from codebases c
      left join codebase_members m on m.codebase_id = c.codebase_id
      where c.owner_id = ? or (m.user_id = ? and m.status = ?)
      order by c.updated_at desc`,
    params: ['user-a', 'user-a', 'active'],
  }))
  // Its own user upsert / profile read are allowed.
  assert.doesNotThrow(() => assertServerActorStatementAllowed(actor, {
    sql: 'insert into users (user_id, primary_email, created_at, updated_at) values (?, ?, ?, ?) on conflict(user_id) do update set primary_email = excluded.primary_email',
    params: ['user-a', 'a@example.com', 'now', 'now'],
  }))

  const rejected = [
    { name: 'listing another user', sql: 'select * from codebases c left join codebase_members m on m.codebase_id = c.codebase_id where c.owner_id = ?', params: ['user-b'] },
    { name: 'unscoped codebases list', sql: 'select * from codebases order by updated_at desc', params: [] },
    { name: 'unscoped file read', sql: 'select * from files', params: [] },
    { name: 'reading another user row', sql: 'select * from users where user_id = ?', params: ['user-b'] },
    { name: 'upserting another user', sql: 'insert into users (user_id, created_at) values (?, ?)', params: ['user-b', 'now'] },
    { name: 'codebase_id in-list', sql: 'select * from files where codebase_id in (?, ?)', params: ['codebase-a', 'codebase-b'] },
    { name: 'not-equal codebase', sql: 'select * from files where codebase_id != ?', params: ['codebase-b'] },
    { name: 'secret-keyed wrapped_keys', sql: 'select * from wrapped_keys where wrap_id = ? limit 1', params: ['wrap_1'] },
    { name: 'unknown table', sql: 'select * from secrets where codebase_id = ?', params: ['codebase-a'] },
    { name: 'stacked statement', sql: 'select * from files where codebase_id = ?; drop table files', params: ['codebase-a'] },
    { name: 'schema sql', sql: 'drop table files', params: [] },
  ]
  for (const statement of rejected) {
    assert.throws(() => assertServerActorStatementAllowed(actor, statement), /Server actor/, statement.name)
  }
  // Missing/empty user id fails closed regardless of shape.
  assert.throws(() => assertServerActorStatementAllowed({ userId: '' }, {
    sql: 'select * from files where codebase_id = ?', params: ['codebase-a'],
  }), /authenticated user id/)
})

test('server-actor: permits only a sole plain INSERT to create an actor-owned codebase', async () => {
  const db = createServerActorDb()
  const response = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: serverActorCreateCodebaseStatement(),
    ip: '203.0.113.74',
    codebaseId: 'codebase-new',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))

  assert.equal(response.status, 200)
  const createStatements = db.executedStatements.filter(({ sql }) => /^insert into codebases/i.test(sql))
  assert.equal(createStatements.length, 1)
  assert.deepEqual(createStatements[0].params, ['codebase-new', 'New codebase', 'user-a'])

  const wrongOwnerDb = createServerActorDb()
  const wrongOwner = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: serverActorCreateCodebaseStatement({ ownerId: 'user-b' }),
    ip: '203.0.113.75',
    codebaseId: 'codebase-new',
  }), multiTenantEnv({ HOPIT_D1_DB: wrongOwnerDb }))
  assert.equal(wrongOwner.status, 403)
  assert.match((await wrongOwner.json()).errors[0].message, /only create a codebase it owns/)
  assert.equal(wrongOwnerDb.executedStatements.length, 0)

  const upsertDb = createServerActorDb()
  const upsert = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: serverActorCreateCodebaseStatement({ upsert: true }),
    ip: '203.0.113.76',
    codebaseId: 'codebase-new',
  }), multiTenantEnv({ HOPIT_D1_DB: upsertDb }))
  assert.equal(upsert.status, 403)
  assert.match((await upsert.json()).errors[0].message, /not entitled/)
  assert.equal(upsertDb.executedStatements.length, 0)

  const batchDb = createServerActorDb()
  const batched = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: [
      serverActorCreateCodebaseStatement(),
      { sql: 'delete from files where codebase_id = ?', params: ['codebase-new'] },
    ],
    ip: '203.0.113.77',
    codebaseId: 'codebase-new',
  }), multiTenantEnv({ HOPIT_D1_DB: batchDb }))
  assert.equal(batched.status, 403)
  assert.match((await batched.json()).errors[0].message, /single-codebase statement/)
  assert.equal(batchDb.executedStatements.length, 0)
})

test('server-actor: flag OFF refuses the hsa_ token and executes nothing (single-tenant unchanged)', async () => {
  const db = createServerActorDb({ codebases: { 'codebase-a': { ownerId: 'user-a' } } })
  const response = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: { sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] },
    ip: '203.0.113.70',
  }), {
    // No HOPIT_MULTITENANT: the flag is off.
    HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: db,
  })
  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /Authentication error/)
  assert.equal(db.executedStatements.length, 0)
})

test('server-actor: flag ON executes a statement against the user own codebase', async () => {
  const db = createServerActorDb({ codebases: { 'codebase-a': { ownerId: 'user-a' } } })
  const response = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: { sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] },
    ip: '203.0.113.71',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))
  assert.equal(response.status, 200)
  assert.equal(db.executedStatements.length, 1)
  assert.deepEqual(db.executedStatements[0].params, ['codebase-a'])
})

test('server-actor: flag ON rejects a statement against a codebase the user does not own or belong to', async () => {
  // user-a is neither owner nor member of codebase-b.
  const db = createServerActorDb({
    codebases: {
      'codebase-a': { ownerId: 'user-a' },
      'codebase-b': { ownerId: 'user-b' },
    },
  })
  const response = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: { sql: 'select * from files where codebase_id = ?', params: ['codebase-b'] },
    ip: '203.0.113.72',
    codebaseId: 'codebase-b',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))
  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /not entitled/)
  assert.equal(db.executedStatements.length, 0)
})

test('server-actor: flag ON lets a user list and read their own multiple codebases', async () => {
  const db = createServerActorDb({
    codebases: {
      'codebase-a': { ownerId: 'user-a' },
      'codebase-c': { ownerId: 'other', members: { 'user-a': 'active' } },
    },
  })
  // Cross-codebase listing anchored to the actor's own id: no per-codebase check.
  const listing = await worker.fetch(serverActorRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: {
      sql: 'select distinct c.* from codebases c left join codebase_members m on m.codebase_id = c.codebase_id where c.owner_id = ? or (m.user_id = ? and m.status = ?) order by c.updated_at desc',
      params: ['user-a', 'user-a', 'active'],
    },
    ip: '203.0.113.73',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))
  assert.equal(listing.status, 200)

  // An owned codebase and a codebase the user is an active member of both pass.
  for (const codebaseId of ['codebase-a', 'codebase-c']) {
    const response = await worker.fetch(serverActorRequest({
      token: mintTestServerActorToken({ userId: 'user-a' }),
      body: { sql: `select * from issues where codebase_id = ?`, params: [codebaseId] },
      ip: '203.0.113.74',
      codebaseId,
    }), multiTenantEnv({ HOPIT_D1_DB: db }))
    assert.equal(response.status, 200, codebaseId)
  }
})

test('server-actor: flag ON rejects forged and expired tokens before execution', async () => {
  const db = createServerActorDb({ codebases: { 'codebase-a': { ownerId: 'user-a' } } })
  const forged = mintTestServerActorToken({ userId: 'user-a', secret: 'wrong-secret' })
  const forgedResponse = await worker.fetch(serverActorRequest({
    token: forged,
    body: { sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] },
    ip: '203.0.113.75',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))
  assert.equal(forgedResponse.status, 403)
  assert.equal(db.executedStatements.length, 0)

  const expired = mintTestServerActorToken({ userId: 'user-a', ttlMs: -1000 })
  const expiredResponse = await worker.fetch(serverActorRequest({
    token: expired,
    body: { sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] },
    ip: '203.0.113.76',
  }), multiTenantEnv({ HOPIT_D1_DB: db }))
  assert.equal(expiredResponse.status, 403)
  assert.equal(db.executedStatements.length, 0)
})

test('server-actor: enabling the flag leaves the proxy token and hst_ session paths unchanged', async () => {
  // Proxy token still short-circuits all scoping with the flag on.
  const proxyResponse = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.77',
    },
    body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] }),
  }), multiTenantEnv({ HOPIT_D1_DB: createMockDb() }))
  assert.equal(proxyResponse.status, 200)

  // hst_ scoped session still enforces its single-codebase firewall with the flag on.
  const hstDb = createMockDb({ session: crossTenantSession() })
  const hstResponse = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-b',
      'cf-connecting-ip': '203.0.113.78',
    },
    body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] }),
  }), multiTenantEnv({ HOPIT_D1_DB: hstDb }))
  assert.equal(hstResponse.status, 403)
  assert.match((await hstResponse.json()).errors[0].message, /must be constrained to its codebase/)
  assert.equal(hstDb.executedStatements.length, 0)
})

// --- Owner-only service operations -----------------------------------------

function adminOperationsRequest({ userId = 'owner-user', method = 'GET', body } = {}) {
  return new Request('https://worker.example/admin/operations', {
    method,
    headers: {
      authorization: `Bearer ${mintTestServerActorToken({ userId })}`,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.130',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function createAdminOperationsDb() {
  const state = {
    controls: new Map(),
    adminEvents: [],
    session: {
      session_id: 'session-owner-1', user_id: 'owner-user', codebase_id: 'repo-1', device_name: 'Owner Mac',
      status: 'active', capabilities_json: '["read","write","sync"]', expires_at: null,
      created_at: '2026-07-13T00:00:00.000Z', last_seen_at: '2026-07-14T12:00:00.000Z', revoked_at: null,
    },
    device: {
      device_id: 'device-owner-1', user_id: 'owner-user', display_name: 'Owner Mac', platform: 'darwin',
      status: 'trusted', created_at: '2026-07-13T00:00:00.000Z', trusted_at: '2026-07-13T00:01:00.000Z',
      revoked_at: null, last_seen_at: '2026-07-14T12:00:00.000Z',
    },
    authorization: {
      authorization_id: 'auth-owner-1', device_id: 'device-owner-1', device_name: 'Owner Mac', platform: 'darwin',
      status: 'pending', user_id: 'owner-user', codebase_id: 'repo-1', session_id: 'session-owner-1',
      created_at: '2026-07-14T12:00:00.000Z', expires_at: '2026-07-14T12:10:00.000Z', updated_at: '2026-07-14T12:00:00.000Z',
    },
    job: {
      job_id: 'job-owner-1', codebase_id: 'repo-1', kind: 'test', command: 'npm test', status: 'failed',
      requested_by_user_id: 'owner-user', created_at: '2026-07-14T11:00:00.000Z', updated_at: '2026-07-14T11:05:00.000Z',
    },
  }
  const users = [
    { user_id: 'owner-user', primary_email: 'owner@example.com', display_name: 'Owner', email_verified: 1, created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z' },
    { user_id: 'tenant-2', primary_email: 'tenant@example.com', display_name: 'Tenant', email_verified: 1, created_at: '2026-07-12T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z' },
  ]
  const db = {
    state,
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      return {
        bind(...params) {
          return {
            async all() {
              if (normalized.includes('from users where user_id')) return { results: users.filter((user) => user.user_id === params[0]) }
              if (normalized.includes('count(*) as total_users')) return { results: [{ total_users: state.aggregateTotals?.users ?? users.length, verified_users: 2, new_users_24h: 0, new_users_7d: 1, new_users_30d: 2 }] }
              if (state.failSnapshotAfterMutation && normalized.includes('from users order by')) throw new Error('snapshot read failed')
              if (normalized.includes('from users order by')) return { results: users }
              if (normalized.includes('from tenant_usage u left join tenant_controls')) {
                const control = state.controls.get('owner-user')
                return { results: [{
                  tenant_id: 'owner-user', plan: 'paid', storage_bytes: 12_000_000_000,
                  write_day: utcDay(), rows_written_today: 10_000, created_at: '2026-07-01T00:00:00.000Z',
                  updated_at: '2026-07-14T12:00:00.000Z', writes_paused: control?.writes_paused ?? 0,
                  pause_reason: control?.reason ?? null, control_updated_at: control?.updated_at ?? null,
                }] }
              }
              if (normalized.startsWith('select * from subscriptions')) return { results: [{ tenant_id: 'owner-user', provider: 'stripe_managed_payments', plan_key: 'plus', status: 'active', entitlement_active: 1, cancel_at_period_end: 0, current_period_end: null, updated_at: '2026-07-14T00:00:00.000Z' }] }
              if (normalized.includes('from subscriptions group by status')) return { results: [{ status: 'active', count: 1, active_count: 1 }] }
              if (normalized.includes('count(*) as tenant_count')) return { results: [{ tenant_count: state.aggregateTotals?.tenants ?? 1, total_storage_bytes: 12_000_000_000, rows_written_today: 10_000, storage_at_50: 0, storage_at_warn: 0, storage_blocked: 0, writes_at_50: 1, writes_at_warn: 0, writes_blocked: 0 }] }
              if (normalized.includes('from tenant_usage group by case')) return { results: [{ plan: 'paid', count: 1 }] }
              if (normalized.includes('(select count(*) from codebases) as codebases')) return { results: [{ codebases: state.aggregateTotals?.codebases ?? 1, sessions: state.aggregateTotals?.sessions ?? 1, devices: state.aggregateTotals?.devices ?? 1, active_devices: state.device.status === 'trusted' ? 1 : 0, revoked_devices: state.device.status === 'revoked' ? 1 : 0, device_authorizations: state.aggregateTotals?.deviceAuthorizations ?? 1, pending_device_authorizations: state.authorization.status === 'pending' ? 1 : 0, action_jobs: state.aggregateTotals?.actionJobs ?? 1, admin_events: state.aggregateTotals?.adminEvents ?? state.adminEvents.length, webhooks: state.aggregateTotals?.webhooks ?? 1 }] }
              if (normalized.includes('from codebases group by owner_id')) return { results: [{ tenant_id: 'owner-user', codebase_count: 1, file_count: 2, last_codebase_update: '2026-07-14T12:00:00.000Z' }] }
              if (normalized.includes('count(*) as session_count')) return { results: [{ tenant_id: 'owner-user', session_count: 1, active_session_count: state.session.status === 'active' ? 1 : 0, last_seen_at: state.session.last_seen_at }] }
              if (normalized.includes('from agent_sessions s join codebases c') && normalized.includes('s.session_id')) return { results: [{ ...state.session, tenant_id: 'owner-user', codebase_name: 'HopIt' }] }
              if (normalized.includes('from device_authorizations order by')) return { results: [state.authorization] }
              if (normalized.includes('from device_keys order by')) return { results: [state.device] }
              if (normalized.includes('from action_jobs j left join')) return { results: [{ ...state.job, codebase_name: 'HopIt', tenant_id: 'owner-user' }] }
              if (normalized.includes('from action_jobs') && normalized.includes('group by status')) return { results: [{ status: state.job.status, count: 1 }] }
              if (normalized.includes('from agent_events e')) return { results: [{ id: 1, codebase_id: 'repo-1', codebase_name: 'HopIt', tenant_id: 'owner-user', event: 'sync.complete', at: '2026-07-14T12:00:00.000Z', source: 'agent' }] }
              if (normalized.includes('from service_admin_events order by')) return { results: [...state.adminEvents].reverse() }
              if (normalized.includes('from billing_webhook_events')) return { results: [{ received_at: '2026-07-14T11:00:00.000Z', event_created_at: '2026-07-14T11:00:00.000Z' }] }
              if (normalized.includes('select tenant_id from tenant_usage')) return { results: params[0] === 'owner-user' ? [{ tenant_id: 'owner-user' }] : [] }
              if (normalized.includes('select session_id, codebase_id, status from agent_sessions')) return { results: params[0] === state.session.session_id ? [state.session] : [] }
              if (normalized.includes('select device_id, user_id, status from device_keys')) return { results: params[0] === state.device.device_id ? [state.device] : [] }
              if (normalized.startsWith('select session_id from device_authorizations')) return { results: params[0] === state.device.device_id ? [{ session_id: state.session.session_id }] : [] }
              if (normalized.includes('select authorization_id, status, device_id, user_id')) return { results: params[0] === state.authorization.authorization_id ? [state.authorization] : [] }
              if (normalized.includes('select job_id, codebase_id, status from action_jobs')) return { results: params[0] === state.job.job_id ? [state.job] : [] }
              if (normalized.startsWith('insert into tenant_controls')) {
                state.controls.set(params[0], { writes_paused: params[1], reason: params[2], updated_at: params[5] })
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith('update agent_sessions set status')) {
                state.session.status = 'revoked'
                state.session.revoked_at = params[1]
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith('update device_keys set status')) {
                state.device.status = 'revoked'
                state.device.revoked_at = params[0]
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith('update device_authorizations set status')) {
                state.authorization.status = 'expired'
                state.authorization.updated_at = params[0]
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith("update action_jobs set status = 'cancelled'")) {
                state.job.status = 'cancelled'
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith("update action_jobs set status = 'queued'")) {
                state.job.status = 'queued'
                return { success: true, results: [], meta: { changes: 1 } }
              }
              if (normalized.startsWith('insert into service_admin_events')) {
                state.adminEvents.push({ event_id: params[0], actor_user_id: params[1], action: params[2], target_type: params[3], target_id: params[4], detail_json: params[5], created_at: params[6] })
                return { success: true, results: [], meta: { changes: 1 } }
              }
              return { results: [] }
            },
          }
        },
      }
    },
  }
  return db
}

function adminOperationsEnv(db) {
  return {
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
    HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
    HOPIT_OWNER_EMAIL: 'owner@example.com',
    HOPIT_D1_DB: db,
  }
}

test('operations: only the verified service owner can read cross-tenant health', async () => {
  const db = createAdminOperationsDb()
  const owner = await worker.fetch(adminOperationsRequest(), adminOperationsEnv(db))
  assert.equal(owner.status, 200)
  const result = (await owner.json()).result
  assert.equal(result.totals.users, 2)
  assert.equal(result.totals.activeSubscriptions, 1)
  assert.equal(result.tenants[0].quota.storage.limit, 30_000_000_000)
  assert.equal(result.sessions[0].deviceName, 'Owner Mac')

  const stranger = await worker.fetch(adminOperationsRequest({ userId: 'tenant-2' }), adminOperationsEnv(db))
  assert.equal(stranger.status, 403)
  assert.match((await stranger.json()).errors[0].message, /not the HopIt service owner/)
})

test('operations: global aggregates remain complete when detail collections are bounded', async () => {
  const db = createAdminOperationsDb()
  db.state.aggregateTotals = {
    users: 300,
    tenants: 300,
    codebases: 400,
    sessions: 500,
    devices: 350,
    deviceAuthorizations: 320,
    actionJobs: 700,
    adminEvents: 450,
    webhooks: 275,
  }
  const response = await worker.fetch(adminOperationsRequest(), adminOperationsEnv(db))
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.equal(result.totals.users, 300)
  assert.equal(result.totals.tenants, 300)
  assert.deepEqual(result.collections.tenants, { shown: 1, total: 300, truncated: true })
  assert.deepEqual(result.collections.codebases, { shown: 0, total: 400, truncated: true })
  assert.deepEqual(result.collections.sessions, { shown: 1, total: 500, truncated: true })
})

test('operations: flag off makes the owner endpoint nonexistent', async () => {
  const db = createAdminOperationsDb()
  const response = await worker.fetch(adminOperationsRequest(), {
    ...adminOperationsEnv(db),
    HOPIT_MULTITENANT: '0',
  })
  assert.equal(response.status, 404)
})

test('operations: pause and resume are confirmed, reversible, and audited', async () => {
  const db = createAdminOperationsDb()
  const unconfirmed = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'pause_tenant_writes', tenantId: 'owner-user', confirmation: 'wrong' },
  }), adminOperationsEnv(db))
  assert.equal(unconfirmed.status, 400)

  const paused = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'pause_tenant_writes', tenantId: 'owner-user', confirmation: 'owner-user', reason: 'abuse review' },
  }), adminOperationsEnv(db))
  assert.equal(paused.status, 200)
  assert.equal((await paused.json()).result.tenants[0].writesPaused, true)
  assert.equal(db.state.adminEvents.at(-1).action, 'pause_tenant_writes')

  const resumed = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'resume_tenant_writes', tenantId: 'owner-user', confirmation: 'owner-user' },
  }), adminOperationsEnv(db))
  assert.equal(resumed.status, 200)
  assert.equal((await resumed.json()).result.tenants[0].writesPaused, false)
  assert.equal(db.state.adminEvents.at(-1).action, 'resume_tenant_writes')
})

test('operations: revoking a device session updates fleet health and audit history', async () => {
  const db = createAdminOperationsDb()
  const response = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'revoke_session', sessionId: 'session-owner-1', confirmation: 'session-owner-1' },
  }), adminOperationsEnv(db))
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.equal(result.sessions[0].status, 'revoked')
  assert.equal(result.totals.activeSessions, 0)
  assert.equal(db.state.adminEvents.at(-1).action, 'revoke_session')
})

test('operations: tenant containment revokes every active session and is audited', async () => {
  const db = createAdminOperationsDb()
  const response = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'revoke_tenant_sessions', tenantId: 'owner-user', confirmation: 'owner-user' },
  }), adminOperationsEnv(db))
  assert.equal(response.status, 200)
  assert.equal(db.state.session.status, 'revoked')
  assert.equal(db.state.adminEvents.at(-1).action, 'revoke_tenant_sessions')
})

test('operations: revoking a trusted device also revokes linked sessions and pending setup', async () => {
  const db = createAdminOperationsDb()
  const response = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'revoke_device', deviceId: 'device-owner-1', confirmation: 'device-owner-1' },
  }), adminOperationsEnv(db))
  assert.equal(response.status, 200)
  assert.equal(db.state.device.status, 'revoked')
  assert.equal(db.state.session.status, 'revoked')
  assert.equal(db.state.authorization.status, 'expired')
  assert.equal(db.state.adminEvents.at(-1).action, 'revoke_device')
})

test('operations: queued jobs can be canceled and failed jobs can be requeued', async () => {
  const db = createAdminOperationsDb()
  const requeued = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'requeue_action_job', jobId: 'job-owner-1', confirmation: 'job-owner-1' },
  }), adminOperationsEnv(db))
  assert.equal(requeued.status, 200)
  assert.equal(db.state.job.status, 'queued')

  const canceled = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'cancel_action_job', jobId: 'job-owner-1', confirmation: 'job-owner-1' },
  }), adminOperationsEnv(db))
  assert.equal(canceled.status, 200)
  assert.equal(db.state.job.status, 'cancelled')
  assert.deepEqual(db.state.adminEvents.slice(-2).map((event) => event.action), ['requeue_action_job', 'cancel_action_job'])
})

test('operations: a committed action stays successful when the follow-up snapshot fails', async () => {
  const db = createAdminOperationsDb()
  db.state.failSnapshotAfterMutation = true
  const response = await worker.fetch(adminOperationsRequest({
    method: 'POST', body: { action: 'pause_tenant_writes', tenantId: 'owner-user', confirmation: 'owner-user' },
  }), adminOperationsEnv(db))
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.equal(result.snapshotAvailable, false)
  assert.equal(result.actionResult.action, 'pause_tenant_writes')
  assert.equal(db.state.controls.get('owner-user').writes_paused, 1)
})

async function captureLogs(callback) {
  const logs = []
  const originalLog = console.log
  console.log = (message) => logs.push(String(message))
  try {
    await callback()
  } finally {
    console.log = originalLog
  }
  return logs
}

function scopedQueryRequest(body, ip) {
  return new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  })
}

function journalSelectedStates(effectiveVisibility) {
  const previous = {
    type: 'active-change-set',
    id: 'cs_1',
    revision: 1,
    effectiveVisibility,
    mergeState: 'unmerged',
  }
  return { previous, next: { ...previous, revision: 2 } }
}

function createScopedMutationDb(selectedState, effectiveVisibility) {
  return createMockDb({
    session: scopedSession({
      user_id: 'user-member',
      capabilities_json: JSON.stringify(['read', 'write']),
    }),
    codebase: {
      codebase_id: 'codebase-1',
      owner_id: 'user-owner',
      revision: selectedState.revision,
      selected_state_json: JSON.stringify(selectedState),
      visibility_json: JSON.stringify({ effective: effectiveVisibility }),
    },
    membership: { role: 'member', status: 'active' },
  })
}

function guardedJournalBatch({ path, operation = 'write', previousSelectedState, nextSelectedState }) {
  const now = '2026-07-08T00:00:00.000Z'
  const main = { id: 'main', revision: 1 }
  const head = {
    sql: 'update codebases set revision = ?, selected_state_json = ?, main_json = ?, file_count = ?, private_file_count = ?, updated_at = ? where codebase_id = ? and revision = ? and selected_state_json = ? and main_json = ?',
    params: [
      2,
      JSON.stringify(nextSelectedState),
      JSON.stringify(main),
      1,
      path.startsWith('.private/') ? 1 : 0,
      now,
      'codebase-1',
      1,
      JSON.stringify(previousSelectedState),
      JSON.stringify(main),
    ],
  }
  const file = operation === 'delete'
    ? {
        sql: `delete from files
          where codebase_id = ? and path = ?
            and exists (
              select 1 from codebases
              where codebase_id = ? and revision = ? and updated_at = ?
            )`,
        params: ['codebase-1', path, 'codebase-1', 2, now],
      }
    : {
        sql: `insert into files (
          codebase_id, path, kind, content, encoding, target, blob_hash, blob_provider,
          blob_key, blob_size, client_encryption_json, encryption_json, privacy_zone,
          zone_id, content_storage, hash, size, scope, revision, updated_at
        ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        where exists (
          select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?
        )
        on conflict(codebase_id, path) do update set
          kind = excluded.kind,
          content = excluded.content,
          encoding = excluded.encoding,
          target = excluded.target,
          blob_hash = excluded.blob_hash,
          blob_provider = excluded.blob_provider,
          blob_key = excluded.blob_key,
          blob_size = excluded.blob_size,
          client_encryption_json = excluded.client_encryption_json,
          encryption_json = excluded.encryption_json,
          privacy_zone = excluded.privacy_zone,
          zone_id = excluded.zone_id,
          content_storage = excluded.content_storage,
          hash = excluded.hash,
          size = excluded.size,
          scope = excluded.scope,
          revision = excluded.revision,
          updated_at = excluded.updated_at`,
        params: [
          'codebase-1',
          path,
          'file',
          'changed',
          'utf8',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          path.startsWith('.private/') ? 'owner-private' : 'repo-content',
          `codebase-1:${path.startsWith('.private/') ? 'owner-private' : 'repo-content'}`,
          'inline',
          'hash',
          7,
          path.startsWith('.private/') ? 'owner-private' : 'shared',
          2,
          now,
          'codebase-1',
          2,
          now,
        ],
      }
  const version = {
    sql: `insert into file_versions (
      codebase_id, selected_state_type, selected_state_id, main_state_id,
      graph_revision, path, operation, kind, old_revision, new_revision,
      old_file_json, new_file_json, scope, privacy_zone, zone_id,
      content_storage, blob_provider, blob_key, blob_hash, encoding,
      target, size, actor_user_id, session_id, device_name, created_at
    ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    where exists (
      select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?
    )`,
    params: [
      'codebase-1',
      'active-change-set',
      'cs_1',
      'main',
      2,
      path,
      operation === 'delete' ? 'delete' : 'modify',
      'file',
      1,
      operation === 'delete' ? null : 2,
      '{}',
      operation === 'delete' ? null : '{}',
      path.startsWith('.private/') ? 'owner-private' : 'shared',
      path.startsWith('.private/') ? 'owner-private' : 'repo-content',
      `codebase-1:${path.startsWith('.private/') ? 'owner-private' : 'repo-content'}`,
      'inline',
      null,
      null,
      null,
      'utf8',
      null,
      7,
      'user-member',
      'session-1',
      'test',
      now,
      'codebase-1',
      2,
      now,
    ],
  }
  return [head, file, version]
}

function legacyGuardedJournalBatch(options) {
  const batch = guardedJournalBatch(options)
  batch[0] = {
    sql: batch[0].sql.replace(' and selected_state_json = ? and main_json = ?', ''),
    params: batch[0].params.slice(0, 8),
  }
  return batch
}

function createMockDb({ session = null, codebase = null, files = [], membership = null } = {}) {
  const db = {
    executedStatements: [],
    sessionLookups: 0,
    prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind(...params) {
          return {
            async all() {
              if (normalized.includes('from agent_sessions')) {
                db.sessionLookups += 1
                return { results: session ? [session] : [] }
              }
              if (normalized.includes('from codebases c') && normalized.includes('left join codebase_members')) {
                return {
                  results: codebase
                    ? [{
                        owner_id: codebase.owner_id,
                        revision: codebase.revision,
                        selected_state_json: codebase.selected_state_json,
                        main_json: codebase.main_json ?? JSON.stringify({ id: 'main', revision: 1 }),
                        visibility_json: codebase.visibility_json,
                        member_role: membership?.role ?? null,
                        member_status: membership?.status ?? null,
                      }]
                    : [],
                }
              }
              if (normalized.includes('select codebase_id, revision, selected_state_json from codebases')) {
                return { results: codebase ? [codebase] : [] }
              }
              if (normalized.startsWith('select * from files')) {
                db.executedStatements.push({ sql, params })
                return { results: [...files].sort((left, right) => left.path.localeCompare(right.path)) }
              }
              if (normalized.includes('select path, scope from files')) {
                const revision = params[1]
                return {
                  results: files
                    .filter((file) => !Number.isInteger(revision) || file.revision === revision)
                    .sort((left, right) => left.path.localeCompare(right.path)),
                }
              }
              db.executedStatements.push({ sql, params })
              return {
                results: [],
                meta: { duration: 1 },
              }
            },
          }
        },
      }
    },
  }
  return db
}

function createAtomicBatchDb({ failAt = null } = {}) {
  const db = {
    state: { codebaseRevision: 1, fileRevision: 1 },
    batchCalls: 0,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              const normalized = sql.trim().toLowerCase()
              if (normalized.startsWith('update codebases')) db.state.codebaseRevision = params[0]
              if (normalized.startsWith('update files')) db.state.fileRevision = params[0]
              return { success: true, results: [], meta: { changes: 1, duration: 1 } }
            },
          }
        },
      }
    },
    async batch(statements) {
      db.batchCalls += 1
      const snapshot = { ...db.state }
      try {
        const results = []
        for (let index = 0; index < statements.length; index += 1) {
          if (index === failAt) throw new Error('synthetic batch failure')
          results.push(await statements[index].all())
        }
        return results
      } catch (error) {
        Object.assign(db.state, snapshot)
        throw error
      }
    },
  }
  return db
}

function scopedSession(overrides = {}) {
  return {
    session_id: 'session-1',
    user_id: 'user-1',
    codebase_id: 'codebase-1',
    status: 'active',
    expires_at: null,
    capabilities_json: JSON.stringify(['read', 'write', 'review', 'release', 'admin']),
    ...overrides,
  }
}

function createMockPushNamespace({ notifyStatus = 200 } = {}) {
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
            return new Response(JSON.stringify({ success: notifyStatus < 400 }), { status: notifyStatus })
          }
          return new Response('upgrade-ok')
        },
      }
    },
  }
  return namespace
}

function createMockDurableObjectState() {
  const values = new Map()
  const sockets = new Set()
  return {
    storage: {
      async get(key) {
        return values.get(key)
      },
      async put(key, value) {
        values.set(key, value)
      },
    },
    acceptWebSocket(socket, tags = []) {
      socket.tags = tags
      sockets.add(socket)
    },
    getWebSockets() {
      return [...sockets]
    },
  }
}

function createMockSocket() {
  return {
    sent: [],
    tags: [],
    attachment: null,
    send(message) {
      this.sent.push(message)
    },
    close() {
      this.closed = true
    },
    serializeAttachment(value) {
      this.attachment = value
    },
    deserializeAttachment() {
      return this.attachment
    },
  }
}

// ---------------------------------------------------------------------------
// Blob broker (Phase 3 Stage 1b: HOPIT_MULTITENANT / Front 2)
//
// The agent no longer holds account-level R2 credentials. It asks the Worker
// broker (authed by its existing hst_ session or the hsa_ server-actor) for a
// short-lived per-object presigned URL scoped to ONLY its codebase's key prefix.
// A caller entitled to codebase A must never obtain a working URL for codebase B:
// a request naming B is refused at entitlement, and a B-key under an A entitlement
// fails the prefix check before anything is signed. Flag OFF: the endpoint does
// not exist (404), so the direct-credential blob path is unchanged.
// ---------------------------------------------------------------------------

const BROKER_R2_ENV = {
  HOPIT_R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  HOPIT_R2_BUCKET: 'hopit-blobs',
  HOPIT_R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  HOPIT_R2_SECRET_ACCESS_KEY: 'secret-example',
  HOPIT_R2_REGION: 'auto',
}
const HEX64 = 'b'.repeat(64)

function managedKey(codebaseId, hash = HEX64, prefix = '') {
  const enc = encodeURIComponent(codebaseId)
  const parts = [prefix, 'codebases', enc, 'blobs', 'sha256', hash.slice(0, 2), hash].filter(Boolean)
  return parts.join('/')
}

function brokerRequest({ token, body, ip = '203.0.113.90' }) {
  return new Request('https://worker.example/blob-presign', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  })
}

const brokerEnv = (extra = {}) => ({
  HOPIT_MULTITENANT: '1',
  HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
  HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
  ...BROKER_R2_ENV,
  ...extra,
})

test('broker key-scope: own-codebase managed keys pass, foreign/traversal/widen keys fail', () => {
  const prefix = 'hopit-prod'
  assert.equal(isBrokerKeyForCodebase(managedKey('codebase-a', HEX64, prefix), 'codebase-a', prefix), true)
  // A key that belongs to codebase-b can never validate under a codebase-a entitlement.
  assert.equal(isBrokerKeyForCodebase(managedKey('codebase-b', HEX64, prefix), 'codebase-a', prefix), false)
  // Prefix mismatch (agent/worker prefixes must agree) fails closed.
  assert.equal(isBrokerKeyForCodebase(managedKey('codebase-a', HEX64, ''), 'codebase-a', prefix), false)
  // Path traversal / doubled separators are rejected outright.
  assert.equal(isBrokerKeyForCodebase(`${prefix}/codebases/codebase-a/blobs/sha256/../${HEX64}`, 'codebase-a', prefix), false)
  assert.throws(() => assertBrokerKeyForCodebase(managedKey('codebase-b', HEX64, prefix), 'codebase-a', prefix), /outside the entitled codebase prefix/)
  assert.doesNotThrow(() => assertBrokerKeyForCodebase(managedKey('codebase-a', HEX64, prefix), 'codebase-a', prefix))
})

test('broker presign: produces a method-scoped SigV4 query URL for the exact object', async () => {
  const key = managedKey('codebase-a')
  const put = await presignBlobUrl({
    method: 'PUT',
    key,
    endpoint: 'https://accountid.r2.cloudflarestorage.com',
    bucket: 'hopit-blobs',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-example',
    now: new Date('2026-07-13T00:00:00.000Z'),
  })
  assert.match(put.url, /^https:\/\/accountid\.r2\.cloudflarestorage\.com\/hopit-blobs\/codebases\/codebase-a\/blobs\/sha256\//)
  assert.match(put.url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/)
  assert.match(put.url, /X-Amz-Expires=120/)
  assert.match(put.url, /X-Amz-SignedHeaders=host/)
  assert.match(put.url, /X-Amz-Signature=[0-9a-f]{64}$/)
  assert.equal(put.method, 'PUT')
  // A GET presign for the same object signs to a different signature (method is signed).
  const get = await presignBlobUrl({
    method: 'GET',
    key,
    endpoint: 'https://accountid.r2.cloudflarestorage.com',
    bucket: 'hopit-blobs',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-example',
    now: new Date('2026-07-13T00:00:00.000Z'),
  })
  assert.notEqual(get.url, put.url)
})

test('broker: flag OFF makes the endpoint 404 (single-tenant blob path unchanged)', async () => {
  const response = await worker.fetch(brokerRequest({
    token: 'hst_session_token',
    body: { method: 'GET', key: managedKey('codebase-1') },
  }), {
    // No HOPIT_MULTITENANT.
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    ...BROKER_R2_ENV,
    HOPIT_D1_DB: createMockDb({ session: scopedSession() }),
  })
  assert.equal(response.status, 404)
})

test('broker: hst_ session gets a presigned URL scoped to its own codebase', async () => {
  const db = createMockDb({ session: scopedSession() }) // codebase_id: codebase-1
  const response = await worker.fetch(brokerRequest({
    token: 'hst_session_token',
    body: { method: 'PUT', key: managedKey('codebase-1') },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.match(result.url, /\/codebases\/codebase-1\/blobs\/sha256\//)
  assert.equal(result.method, 'PUT')
})

test('broker: hst_ session cannot presign a key for another codebase (prefix refused)', async () => {
  const db = createMockDb({ session: scopedSession() }) // scoped to codebase-1
  const response = await worker.fetch(brokerRequest({
    token: 'hst_session_token',
    body: { method: 'GET', key: managedKey('codebase-2') },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).errors[0].message, /outside the entitled codebase prefix/)
})

test('broker: hst_ session naming a foreign codebaseId is refused at auth', async () => {
  const db = createMockDb({ session: scopedSession() }) // scoped to codebase-1
  const response = await worker.fetch(brokerRequest({
    token: 'hst_session_token',
    body: { method: 'GET', key: managedKey('codebase-2'), codebaseId: 'codebase-2' },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(response.status, 403)
  assert.match((await response.json()).errors[0].message, /not scoped to the requested codebase/)
})

test('broker: hsa_ server-actor gets a URL for an entitled codebase and is refused for others', async () => {
  const db = createServerActorDb({
    codebases: {
      'codebase-a': { ownerId: 'user-a' },
      'codebase-b': { ownerId: 'user-b' },
    },
  })
  const entitled = await worker.fetch(brokerRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: { method: 'PUT', key: managedKey('codebase-a'), codebaseId: 'codebase-a' },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(entitled.status, 200)
  assert.match((await entitled.json()).result.url, /\/codebases\/codebase-a\/blobs\//)

  const refused = await worker.fetch(brokerRequest({
    token: mintTestServerActorToken({ userId: 'user-a' }),
    body: { method: 'GET', key: managedKey('codebase-b'), codebaseId: 'codebase-b' },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(refused.status, 403)
  assert.match((await refused.json()).errors[0].message, /not entitled/)
})

test('broker: forged, unscoped, and unknown principals are all refused before signing', async () => {
  const db = createServerActorDb({ codebases: { 'codebase-a': { ownerId: 'user-a' } } })
  // Forged server-actor signature.
  const forged = await worker.fetch(brokerRequest({
    token: mintTestServerActorToken({ userId: 'user-a', secret: 'wrong-secret' }),
    body: { method: 'GET', key: managedKey('codebase-a'), codebaseId: 'codebase-a' },
  }), brokerEnv({ HOPIT_D1_DB: db }))
  assert.equal(forged.status, 403)
  // A non-hst_/non-hsa_/non-proxy token.
  const unknown = await worker.fetch(brokerRequest({
    token: 'garbage-token',
    body: { method: 'GET', key: managedKey('codebase-a') },
  }), brokerEnv({ HOPIT_D1_DB: createMockDb({ session: null }) }))
  assert.equal(unknown.status, 403)
  // A missing session.
  const missing = await worker.fetch(brokerRequest({
    token: 'hst_unknown',
    body: { method: 'GET', key: managedKey('codebase-1') },
  }), brokerEnv({ HOPIT_D1_DB: createMockDb({ session: null }) }))
  assert.equal(missing.status, 403)
})

test('broker: unconfigured R2 answers 503 without signing', async () => {
  const response = await worker.fetch(brokerRequest({
    token: 'hst_session_token',
    body: { method: 'GET', key: managedKey('codebase-1') },
  }), {
    HOPIT_MULTITENANT: '1',
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: createMockDb({ session: scopedSession() }),
  })
  assert.equal(response.status, 503)
})

// ===========================================================================
// Per-tenant usage metering + quota enforcement (Phase 3 Stage 2-3)
//
// HOPIT_MULTITENANT off  => zero metering, byte-for-byte behavior (no meter row
//                           appended; existing suites above are the flag-off
//                           regression proof).
// HOPIT_MULTITENANT on   => one meter upsert folded into each mutating batch.
// + HOPIT_ENFORCE_QUOTA  => a write past the hard cap is rejected at the Worker
//                           (429) BEFORE any statement runs (no data loss); the
//                           agent holds the change on disk. Reads/exports are
//                           never routed through the gate.
// ===========================================================================

const TODAY = utcDay()

// --- quota.js pure helpers ---------------------------------------------------

test('quota: resolvePlanLimits returns free/paid defaults and honors env knobs', () => {
  const free = resolvePlanLimits({}, 'free')
  assert.deepEqual(
    { s: free.storageBytes, w: free.dailyWrites, c: free.codebases },
    { s: 2_000_000_000, w: 2_000, c: 1 },
  )
  const paid = resolvePlanLimits({}, 'paid')
  assert.deepEqual(
    { s: paid.storageBytes, w: paid.dailyWrites, c: paid.codebases },
    { s: 30_000_000_000, w: 20_000, c: 1_000_000 },
  )
  const paidStorage = resolvePlanLimits({}, 'paid_storage')
  assert.deepEqual(
    { s: paidStorage.storageBytes, w: paidStorage.dailyWrites, c: paidStorage.codebases },
    { s: 100_000_000_000, w: 20_000, c: 1_000_000 },
  )
  // Absent/unknown plan defaults to free.
  assert.equal(resolvePlanLimits({}, undefined).plan, 'free')
  assert.equal(resolvePlanLimits({}, 'enterprise').plan, 'free')
  // Owner-tunable env knobs override the defaults.
  const tuned = resolvePlanLimits({ HOPIT_QUOTA_FREE_STORAGE_BYTES: '500', HOPIT_QUOTA_FREE_DAILY_WRITES: '9' }, 'free')
  assert.equal(tuned.storageBytes, 500)
  assert.equal(tuned.dailyWrites, 9)
  const tunedStorage = resolvePlanLimits({
    HOPIT_QUOTA_PAID_STORAGE_BYTES: '700',
    HOPIT_QUOTA_PAID_STORAGE_DAILY_WRITES: '11',
  }, 'paid_storage')
  assert.equal(tunedStorage.storageBytes, 700)
  assert.equal(tunedStorage.dailyWrites, 11)
})

test('quota: the daily counter resets on a UTC day roll', () => {
  assert.equal(rowsUsedToday({ write_day: TODAY, rows_written_today: 42 }, TODAY), 42)
  assert.equal(rowsUsedToday({ write_day: '2000-01-01', rows_written_today: 42 }, TODAY), 0)
  assert.equal(rowsUsedToday(null, TODAY), 0)
})

test('quota: meterState crosses ok -> warn (80%) -> block (100%)', () => {
  assert.equal(meterState({ used: 799, limit: 1000, warnRatio: 0.8 }), 'ok')
  assert.equal(meterState({ used: 800, limit: 1000, warnRatio: 0.8 }), 'warn')
  assert.equal(meterState({ used: 1000, limit: 1000, warnRatio: 0.8 }), 'block')
  assert.equal(meterState({ used: 5, limit: 0, warnRatio: 0.8 }), 'ok') // unlimited
})

test('quota: evaluateWriteQuota rejects over-daily and over-storage, allows under-cap', () => {
  const limits = resolvePlanLimits({}, 'free')
  // Under cap => allowed.
  assert.equal(evaluateWriteQuota({ usage: null, limits, day: TODAY, rowsDelta: 3, storageDelta: 7 }), null)
  // Daily over cap => typed rejection.
  const daily = evaluateWriteQuota({
    usage: { write_day: TODAY, rows_written_today: 1999 }, limits, day: TODAY, rowsDelta: 3, storageDelta: 0,
  })
  assert.equal(daily.code, 'quota_exceeded_daily')
  assert.equal(daily.limit, 2_000)
  // Storage over cap => typed rejection (daily under cap).
  const storage = evaluateWriteQuota({
    usage: { storage_bytes: 1_999_999_999 }, limits, day: TODAY, rowsDelta: 1, storageDelta: 7,
  })
  assert.equal(storage.code, 'quota_exceeded_storage')
  // A read (rowsDelta 0, storageDelta 0) is never rejected.
  assert.equal(evaluateWriteQuota({
    usage: { write_day: TODAY, rows_written_today: 999_999, storage_bytes: 9_999_999_999 }, limits, day: TODAY, rowsDelta: 0, storageDelta: 0,
  }), null)
})

test('quota: buildMeterUpsertStatement folds a single tenant-keyed upsert', () => {
  const statement = buildMeterUpsertStatement({ tenantId: 'user-owner', day: TODAY, rowsDelta: 3, storageDelta: 7, now: 'now' })
  assert.match(statement.sql, /insert into tenant_usage/)
  assert.match(statement.sql, /on conflict\(tenant_id\) do update set/)
  assert.equal(statement.params[0], 'user-owner')
  assert.ok(statement.params.includes(7)) // storage delta
  assert.ok(statement.params.includes(3)) // rows delta
})

test('quota: computeUsageStatus reports per-line used/limit/ratio/state', () => {
  const status = computeUsageStatus({
    usage: { plan: 'free', storage_bytes: 1_600_000_000, write_day: TODAY, rows_written_today: 100 },
    limits: resolvePlanLimits({}, 'free'),
    warnRatio: 0.8,
    day: TODAY,
    codebaseCount: 1,
  })
  assert.equal(status.plan, 'free')
  assert.equal(status.storage.state, 'warn') // 80% of 2 GB
  assert.equal(status.dailyWrites.limit, 2_000)
  assert.equal(status.codebases.used, 1)
  assert.equal(status.codebases.limit, 1)
})

// --- Worker mutation path: metering + enforcement ----------------------------

// A mutation-capable mock that also answers the tenant meter read and records
// the folded meter upsert. Owner = user-owner (the tenant), writer = an active
// team-member collaborator on a team-visible change set.
function createQuotaMutationDb({ usage = null, control = null, currentFileSize = null } = {}) {
  const selected = { type: 'active-change-set', id: 'cs_1', revision: 1, effectiveVisibility: 'team-visible', mergeState: 'unmerged' }
  const db = {
    executedStatements: [],
    prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind(...params) {
          return {
            async all() {
              if (normalized.includes('from agent_sessions')) {
                return { results: [scopedSession({ user_id: 'user-member', capabilities_json: JSON.stringify(['read', 'write']) })] }
              }
              if (normalized.includes('from codebases c') && normalized.includes('left join codebase_members')) {
                return {
                  results: [{
                    owner_id: 'user-owner',
                    selected_state_json: JSON.stringify(selected),
                    visibility_json: JSON.stringify({ effective: 'team-visible' }),
                    member_role: 'member',
                    member_status: 'active',
                  }],
                }
              }
              if (normalized.startsWith('select owner_id from codebases')) {
                return { results: [{ owner_id: 'user-owner' }] }
              }
              if (normalized.includes('from tenant_usage where tenant_id')) {
                return { results: usage ? [usage] : [] }
              }
              if (normalized.includes('from tenant_controls where tenant_id')) {
                return { results: control ? [control] : [] }
              }
              if (normalized.includes('length(content) as content_size') && normalized.includes('from files where codebase_id')) {
                return { results: currentFileSize == null ? [] : [{ size: currentFileSize, blob_size: null, content_size: currentFileSize }] }
              }
              if (normalized.includes('select count(*) as n from codebases')) {
                return { results: [{ n: 1 }] }
              }
              if (normalized.includes('select codebase_id, revision, selected_state_json from codebases')) {
                return { results: [{ codebase_id: 'codebase-1', revision: 2, selected_state_json: JSON.stringify(selected) }] }
              }
              if (normalized.includes('select path, scope from files')) {
                return { results: [] }
              }
              db.executedStatements.push({ sql, params })
              return { results: [], meta: { duration: 1 } }
            },
          }
        },
      }
    },
  }
  return db
}

function guardedCommitBatch() {
  const states = journalSelectedStates('team-visible')
  return guardedJournalBatch({ path: 'README.md', previousSelectedState: states.previous, nextSelectedState: states.next })
}

test('scoped session upgrades the released legacy guarded head to the current atomic guard', async () => {
  const states = journalSelectedStates('team-visible')
  const db = createScopedMutationDb(states.previous, 'team-visible')
  const response = await worker.fetch(scopedQueryRequest(legacyGuardedJournalBatch({
    path: 'README.md',
    previousSelectedState: states.previous,
    nextSelectedState: states.next,
  }), '203.0.113.120'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })

  assert.equal(response.status, 200)
  const head = db.executedStatements.find((statement) => /^update codebases/i.test(statement.sql.trim()))
  assert.ok(head)
  assert.match(head.sql.replace(/\s+/g, ' '), /and selected_state_json = \? and main_json = \?$/)
  assert.equal(head.params.length, 10)
  assert.equal(head.params[8], JSON.stringify(states.previous))
  assert.equal(head.params[9], JSON.stringify({ id: 'main', revision: 1 }))
})

test('scoped session rejects a legacy guarded head that changes selected-state security fields', async () => {
  const states = journalSelectedStates('team-visible')
  const batch = legacyGuardedJournalBatch({
    path: 'README.md',
    previousSelectedState: states.previous,
    nextSelectedState: { ...states.next, effectiveVisibility: 'private' },
  })
  const db = createScopedMutationDb(states.previous, 'team-visible')
  const response = await worker.fetch(scopedQueryRequest(batch, '203.0.113.121'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })

  assert.equal(response.status, 403)
  assert.equal(db.executedStatements.length, 0)
})

test('scoped session rejects a legacy guarded head that changes Main', async () => {
  const states = journalSelectedStates('team-visible')
  const batch = legacyGuardedJournalBatch({
    path: 'README.md',
    previousSelectedState: states.previous,
    nextSelectedState: states.next,
  })
  batch[0].params[2] = JSON.stringify({ id: 'main', revision: 2 })
  const db = createScopedMutationDb(states.previous, 'team-visible')
  const response = await worker.fetch(scopedQueryRequest(batch, '203.0.113.122'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })

  assert.equal(response.status, 403)
  assert.equal(db.executedStatements.length, 0)
})

const meterStatementsOf = (db) => db.executedStatements.filter((entry) => /insert into tenant_usage/i.test(entry.sql))

test('meter: flag OFF appends no meter upsert and leaves the batch byte-for-byte (flag-off proof)', async () => {
  const db = createQuotaMutationDb()
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.90'), {
    HOPIT_D1_DB: db,
    // No HOPIT_MULTITENANT: metering is entirely off.
  })
  assert.equal(response.status, 200)
  assert.equal(db.executedStatements.length, 3) // exactly the tenant's own 3 statements
  assert.equal(meterStatementsOf(db).length, 0)
})

test('meter: flag ON folds exactly one tenant-keyed meter upsert into the batch (+1 row/save)', async () => {
  const db = createQuotaMutationDb()
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.91'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })
  assert.equal(response.status, 200)
  const meters = meterStatementsOf(db)
  assert.equal(meters.length, 1) // exactly one extra row written per save
  assert.equal(meters[0].params[0], 'user-owner') // accrues to the OWNER tenant
  assert.ok(meters[0].params.includes(3)) // rowsDelta = 3 mutating statements
  assert.ok(meters[0].params.includes(7)) // storageDelta = guarded file size
  // The appended meter result is trimmed from the tenant-visible response.
  const body = await response.json()
  assert.equal(body.result.length, 3)
})

test('meter: replacing a file adds only its trusted net size growth', async () => {
  const db = createQuotaMutationDb({ currentFileSize: 5 })
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.110'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })
  assert.equal(response.status, 200)
  const meter = meterStatementsOf(db)[0]
  assert.ok(meter.params.includes(2)) // 7-byte replacement minus the trusted 5-byte current row
})

test('meter: deleting a file releases its trusted current size even at the daily cap', async () => {
  const states = journalSelectedStates('team-visible')
  const db = createQuotaMutationDb({
    usage: { plan: 'free', write_day: TODAY, rows_written_today: 2_000, storage_bytes: 5 },
    currentFileSize: 5,
  })
  const response = await worker.fetch(scopedQueryRequest(guardedJournalBatch({
    path: 'README.md',
    operation: 'delete',
    previousSelectedState: states.previous,
    nextSelectedState: states.next,
  }), '203.0.113.111'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 200)
  assert.ok(meterStatementsOf(db)[0].params.includes(-5))
})

test('meter: flag ON with enforce ON under cap still writes + meters', async () => {
  const db = createQuotaMutationDb({ usage: { plan: 'free', write_day: TODAY, rows_written_today: 10, storage_bytes: 100 } })
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.92'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 200)
  assert.equal(meterStatementsOf(db).length, 1)
})

test('service control: paused tenant blocks writes but leaves reads and storage-releasing deletes available', async () => {
  const control = { writes_paused: 1, reason: 'abuse review' }
  const blockedDb = createQuotaMutationDb({ control })
  const blocked = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.123'), {
    HOPIT_D1_DB: blockedDb,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).errors[0].quota.code, 'tenant_writes_paused')
  assert.equal(blockedDb.executedStatements.length, 0)

  const states = journalSelectedStates('team-visible')
  const deleteDb = createQuotaMutationDb({ control, currentFileSize: 5 })
  const deletion = await worker.fetch(scopedQueryRequest(guardedJournalBatch({
    path: 'README.md',
    operation: 'delete',
    previousSelectedState: states.previous,
    nextSelectedState: states.next,
  }), '203.0.113.124'), {
    HOPIT_D1_DB: deleteDb,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(deletion.status, 200)
  assert.ok(meterStatementsOf(deleteDb)[0].params.includes(-5))
})

test('enforce: an over-daily-cap write is rejected at the Worker with nothing written (no data loss)', async () => {
  const db = createQuotaMutationDb({ usage: { plan: 'free', write_day: TODAY, rows_written_today: 1999, storage_bytes: 0 } })
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.93'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 429)
  const body = await response.json()
  assert.equal(body.errors[0].quota.code, 'quota_exceeded_daily')
  // Nothing was written: not the tenant's statements, not the meter row.
  assert.equal(db.executedStatements.length, 0)
})

test('enforce: reads for the SAME over-quota tenant still succeed', async () => {
  const db = createQuotaMutationDb({ usage: { plan: 'free', write_day: TODAY, rows_written_today: 999_999, storage_bytes: 9_999_999_999 } })
  const response = await worker.fetch(scopedQueryRequest(
    { sql: 'select * from files where codebase_id = ? order by path asc', params: ['codebase-1'] },
    '203.0.113.94',
  ), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 200) // reads are never routed through the quota gate
})

test('enforce: an over-storage-cap write is rejected with a typed storage error', async () => {
  const db = createQuotaMutationDb({ usage: { plan: 'free', write_day: TODAY, rows_written_today: 0, storage_bytes: 1_999_999_999 } })
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.95'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 429)
  assert.equal((await response.json()).errors[0].quota.code, 'quota_exceeded_storage')
  assert.equal(db.executedStatements.length, 0)
})

test('enforce: the paid plan clears a write the free cap would reject (free vs paid)', async () => {
  const db = createQuotaMutationDb({ usage: { plan: 'paid', write_day: TODAY, rows_written_today: 1999, storage_bytes: 0 } })
  const response = await worker.fetch(scopedQueryRequest(guardedCommitBatch(), '203.0.113.96'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
    HOPIT_ENFORCE_QUOTA: '1',
  })
  assert.equal(response.status, 200) // 1999 + 3 is under the 50k paid daily cap
  assert.equal(meterStatementsOf(db).length, 1)
})

// --- Usage status surface (/usage) ------------------------------------------

function createUsageDb({ usage = null, ownerId = 'user-owner', codebaseCount = 1 } = {}) {
  return {
    prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind() {
          return {
            async all() {
              if (normalized.includes('from agent_sessions')) {
                return { results: [scopedSession({ user_id: 'user-member' })] }
              }
              if (normalized.startsWith('select owner_id from codebases')) {
                return { results: [{ owner_id: ownerId }] }
              }
              if (normalized.includes('from tenant_usage where tenant_id')) {
                return { results: usage ? [usage] : [] }
              }
              if (normalized.includes('select count(*) as n from codebases')) {
                return { results: [{ n: codebaseCount }] }
              }
              return { results: [] }
            },
          }
        },
      }
    },
  }
}

function usageRequest(ip) {
  return new Request('https://worker.example/usage', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify({}),
  })
}

test('usage: the /usage surface is 404 with the flag off (single-tenant unchanged)', async () => {
  const response = await worker.fetch(usageRequest('203.0.113.97'), { HOPIT_D1_DB: createUsageDb() })
  assert.equal(response.status, 404)
})

test('usage: a session sees its own tenant plan, limits, and warn state', async () => {
  const db = createUsageDb({ usage: { plan: 'free', storage_bytes: 1_600_000_000, write_day: TODAY, rows_written_today: 50 } })
  const response = await worker.fetch(usageRequest('203.0.113.98'), {
    HOPIT_D1_DB: db,
    HOPIT_MULTITENANT: '1',
  })
  assert.equal(response.status, 200)
  const { result } = await response.json()
  assert.equal(result.plan, 'free')
  assert.equal(result.storage.limit, 2_000_000_000)
  assert.equal(result.storage.state, 'warn') // 80% of storage
  assert.equal(result.dailyWrites.limit, 2_000)
  assert.equal(result.codebases.used, 1)
  assert.equal(result.enforced, false)
})
