import assert from 'node:assert/strict'
import test from 'node:test'

import worker, { CodebasePushHub } from './api-worker.js'
import { assertScopedSessionStatementAllowed } from './scoped-sql.js'

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
                        selected_state_json: codebase.selected_state_json,
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
