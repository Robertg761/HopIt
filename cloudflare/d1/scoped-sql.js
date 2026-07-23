// Transitional policy for the legacy raw-SQL proxy. Keep this deliberately
// conservative; the durable replacement is a typed operation endpoint whose
// SQL templates live in the Worker rather than arrive from the client.
export function assertScopedSessionStatementAllowed(session, statement) {
  const sql = statement?.sql
  if (typeof sql !== 'string') throw new Error('Expected a SQL statement.')
  const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase()
  const params = Array.isArray(statement.params) ? statement.params : []
  if (!/^(select|insert|update|delete)\b/.test(normalized)) {
    throw new Error('Scoped agent sessions cannot run schema or administrative SQL.')
  }
  assertScopedSqlSyntax(normalized, params)

  const policy = scopedStatementPolicy(normalized, params, session)
  const requiredCapability = policy.requiredCapability
  if (requiredCapability === 'admin' && policy.baseCapability !== 'admin' && !agentSessionHasCapability(session, policy.baseCapability)) {
    throw new Error(`Agent session does not have ${policy.baseCapability} capability.`)
  }
  if (!agentSessionHasCapability(session, requiredCapability)) {
    throw new Error(`Agent session does not have ${requiredCapability} capability.`)
  }

  if (!statementIsScopedToCodebase(normalized, params, session)
    && !statementIsScopedToSessionUser(normalized, params, session)) {
    throw new Error('Scoped agent session SQL must be constrained to its codebase or authenticated user.')
  }

  return policy
}

// --- Server-actor policy tier (Phase 3 Stage 1a, HOPIT_MULTITENANT) ----------
//
// The hosted dashboard historically reached D1 with the omnipotent proxy token,
// which skips every scope check (api-worker.js authorizeRequest -> {kind:'proxy'}).
// The server-actor tier sits BETWEEN that all-powerful proxy token and the
// single-codebase `hst_` session: it carries the authenticated Clerk user id and
// lets a statement touch ONLY codebases that user owns or is an active member of
// (a user listing THEIR OWN codebases is allowed; a statement touching a codebase
// the user neither owns nor belongs to fails closed). This function is the static
// half of the check: it validates statement shape and reports which codebase ids
// the Worker must then confirm the actor is entitled to (dynamic half lives in
// api-worker.js). Deny-by-default: anything it cannot classify as codebase-anchored
// or actor-user-anchored is rejected.
export function assertServerActorStatementAllowed(actor, statement) {
  const sql = statement?.sql
  if (typeof sql !== 'string') throw new Error('Expected a SQL statement.')
  const userId = actor?.userId
  if (!userId) throw new Error('Server actor requires an authenticated user id.')
  const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase()
  const params = Array.isArray(statement.params) ? statement.params : []
  if (!/^(select|insert|update|delete)\b/.test(normalized)) {
    throw new Error('Server actor cannot run schema or administrative SQL.')
  }
  assertServerActorSqlSyntax(normalized, params)

  const operation = normalized.match(/^(select|insert|update|delete)\b/)?.[1] ?? null
  const table = primaryTableForStatement(normalized, operation)
  if (!table) throw new Error('Server actor SQL must target a known table.')

  const codebaseIds = serverActorReferencedCodebaseIds(normalized, params, operation)

  // Creating a brand-new codebase is the one legitimate server-actor operation
  // that cannot pass the dynamic entitlement lookup yet: the row does not exist.
  // Permit only a plain INSERT whose owner_id is the authenticated actor. The
  // Worker separately requires this to be the request's sole statement. UPSERTs
  // stay on the normal entitlement path so a colliding id can never overwrite a
  // codebase owned by another tenant.
  if (table === 'codebases' && operation === 'insert' && !/\bon conflict\b/.test(normalized)) {
    const createsCodebaseId = serverActorInsertedCodebaseId(normalized, params)
    const ownerId = serverActorInsertedColumnValue(normalized, params, 'owner_id')
    if (!createsCodebaseId || ownerId !== userId) {
      throw new Error('Server actor can only create a codebase it owns.')
    }
    return { operation, table, codebaseIds, createsCodebaseId }
  }

  // codebases / codebase_members are the only tables the dashboard reaches
  // across codebases (the "list my codebases" surface). Either they are pinned
  // to specific codebase ids (entitlement-checked by the Worker) or they are
  // anchored to the actor's own user id via owner_id/user_id predicates.
  if (table === 'codebases' || table === 'codebase_members') {
    if (codebaseIds.length > 0) return { operation, table, codebaseIds }
    assertServerActorUserAnchored(normalized, params, userId)
    return { operation, table, codebaseIds: [] }
  }

  // The user's own profile row (and the read-only email lookup invitations need).
  if (table === 'users') {
    assertServerActorUsersStatement(normalized, params, userId, operation)
    return { operation, table, codebaseIds: [] }
  }

  // The user's own per-tenant usage meter (tenant == user in v1). Read-only and
  // anchored to the actor's own tenant_id, so the dashboard can surface "X% of
  // storage / Y% of today's writes" on Plane A without reaching another tenant's
  // meter. Writes to tenant_usage stay on the Worker's folded meter path / the
  // admin proxy, never the dashboard.
  if (table === 'tenant_usage') {
    if (operation !== 'select') throw new Error('Server actor cannot mutate tenant usage.')
    if (!/\btenant_id\s*=\s*\?/.test(normalized)) {
      throw new Error('Server actor tenant usage reads must be anchored to the actor tenant id.')
    }
    if (!params.includes(userId)) {
      throw new Error('Server actor can only read its own tenant usage.')
    }
    return { operation, table, codebaseIds: [] }
  }

  // Every other tenant table must name the codebase it touches so the Worker can
  // confirm the actor is entitled to it. Unknown tables fail closed.
  if (!codebaseScopedTables.has(table)) {
    throw new Error('Server actor cannot access this table.')
  }
  if (codebaseIds.length === 0) {
    throw new Error('Server actor SQL must be constrained to a codebase.')
  }
  return { operation, table, codebaseIds }
}

function assertServerActorSqlSyntax(normalizedSql, params) {
  const codeView = sqlCodeView(normalizedSql)
  if (/;|--|\/\*|\*\//.test(codeView)) {
    throw new Error('Server actor SQL cannot contain comments or multiple statements.')
  }
  if (/\?\d+/.test(codeView)) {
    throw new Error('Server actor SQL must use anonymous parameters.')
  }
  if (countSqlPlaceholders(normalizedSql) !== params.length) {
    throw new Error('Server actor SQL parameter count does not match its placeholders.')
  }
  if (/\b(union|intersect|except|pragma|attach|detach|vacuum|analyze|reindex)\b/.test(codeView)) {
    throw new Error('Server actor SQL contains unsupported syntax.')
  }
  // A codebase_id compared with anything other than a bound equality could fan a
  // single statement out to codebases the Worker cannot enumerate and therefore
  // cannot entitlement-check. Force equality, exactly as the hst_ tier does.
  if (/\bcodebase_id\s*(?:<>|!=|\bin\b|\bnot\s+in\b|\blike\b|\bglob\b)/.test(codeView)) {
    throw new Error('Server actor SQL must use equality for codebase scope.')
  }
}

function serverActorReferencedCodebaseIds(normalizedSql, params, operation) {
  const ids = new Set()
  for (const match of codebasePredicateMatches(normalizedSql)) {
    const value = params[match.ordinal]
    if (typeof value === 'string' && value) ids.add(value)
  }
  if (operation === 'insert') {
    const inserted = serverActorInsertedCodebaseId(normalizedSql, params)
    if (typeof inserted === 'string' && inserted) ids.add(inserted)
  }
  return [...ids]
}

function assertServerActorUserAnchored(normalizedSql, params, userId) {
  const matches = userIdentityPredicateMatches(normalizedSql)
  if (matches.length === 0) {
    throw new Error('Server actor cross-codebase reads must be scoped to the actor user id.')
  }
  for (const match of matches) {
    if (params[match.ordinal] !== userId) {
      throw new Error('Server actor cross-codebase reads must be scoped to the actor user id.')
    }
  }
}

function assertServerActorUsersStatement(normalizedSql, params, userId, operation) {
  if (operation === 'insert') {
    if (serverActorInsertedColumnValue(normalizedSql, params, 'user_id') !== userId) {
      throw new Error('Server actor can only upsert its own user row.')
    }
    return
  }
  if (operation === 'select') {
    const matches = userIdentityPredicateMatches(normalizedSql)
    if (matches.length > 0) {
      for (const match of matches) {
        if (params[match.ordinal] !== userId) {
          throw new Error('Server actor can only read its own user row.')
        }
      }
      return
    }
    // Invitations resolve an invitee by email; this exposes only a user id, never
    // any codebase-scoped data, so it is a permitted actor-neutral read shape.
    if (/^select (?:user_id|\*)(?:, [a-z_][a-z0-9_]*)* from users where primary_email = \? limit 1$/.test(normalizedSql)) {
      return
    }
    throw new Error('Server actor users read shape is not allowed.')
  }
  throw new Error('Server actor cannot modify another user row.')
}

function userIdentityPredicateMatches(normalizedSql) {
  const matches = []
  const pattern = /\b(?:[a-z_][a-z0-9_]*\.)?(?:owner_id|user_id)\s*=\s*\?/g
  for (const match of sqlCodeView(normalizedSql).matchAll(pattern)) {
    const questionIndex = match.index + match[0].lastIndexOf('?')
    matches.push({ ordinal: countSqlPlaceholders(normalizedSql.slice(0, questionIndex)) })
  }
  return matches
}

function serverActorInsertedCodebaseId(normalizedSql, params) {
  return serverActorInsertedColumnValue(normalizedSql, params, 'codebase_id')
}

// Tolerant inserted-column extractor for the server-actor tier. Unlike
// parseScopedInsert (which pins the hst_ guarded-journal grammar and rejects any
// non-codebase ON CONFLICT target), this only needs the bound value of one column
// so it accepts the dashboard's ordinary INSERT ... VALUES / guarded SELECT forms
// and user upserts that conflict on user_id.
function serverActorInsertedColumnValue(normalizedSql, params, column) {
  const head = normalizedSql.match(/^insert\s+into\s+[a-z_][a-z0-9_]*\s*\(([^)]+)\)\s+(.+)$/)
  if (!head) return null
  const columns = head[1].split(',').map((name) => name.trim())
  const columnIndex = columns.indexOf(column)
  if (columnIndex < 0) return null
  const rest = head[2]
  let valueList
  if (rest.startsWith('values')) {
    const openingIndex = rest.indexOf('(')
    const closingIndex = matchingParenthesisIndex(rest, openingIndex)
    if (openingIndex < 0 || closingIndex < 0) return null
    valueList = rest.slice(openingIndex + 1, closingIndex)
  } else if (rest.startsWith('select ')) {
    valueList = rest.slice('select '.length).split(/\bwhere\b/)[0]
  } else {
    return null
  }
  const values = splitSqlList(valueList)
  if (values.length !== columns.length || values[columnIndex] !== '?') return null
  let ordinal = 0
  for (let index = 0; index < columnIndex; index += 1) {
    ordinal += countSqlPlaceholders(values[index])
  }
  return params[ordinal] ?? null
}

function scopedStatementPolicy(normalizedSql, params, session) {
  const operation = normalizedSql.match(/^(select|insert|update|delete)\b/)?.[1] ?? null
  const table = primaryTableForStatement(normalizedSql, operation)
  const fileMutation = scopedFileMutationPolicy(normalizedSql, params, operation, table, session)
  const journalHeadFormat = operation === 'update' && table === 'codebases'
    ? guardedJournalHeadFormat(normalizedSql, updateColumns(normalizedSql))
    : null
  const journalHead = journalHeadFormat
    ? {
        format: journalHeadFormat,
        nextRevision: params[0],
        nextSelectedStateJson: params[1],
        nextMainJson: params[2],
        codebaseId: params[6],
        previousRevision: params[7],
      }
    : null
  let baseCapability = 'write'
  if (operation === 'select') baseCapability = 'read'
  else if (table === 'review_threads' || table === 'review_thread_comments' || table === 'review_decisions') baseCapability = 'review'
  const requiredCapability = (touchesAdminTable(normalizedSql) && !isOwnAgentSessionRead(normalizedSql, params, session))
    || codebaseMutationRequiresAdmin(normalizedSql, params, operation, table)
    || settingsMutationRequiresAdmin(operation, table)
    ? 'admin'
    : baseCapability

  return {
    operation,
    table,
    baseCapability,
    requiredCapability,
    resultVisibility: operation === 'select' && table === 'files'
      ? 'file'
      : operation === 'select' && table === 'file_versions'
        ? 'file-version'
        : operation === 'select' && table === 'file_blobs'
          ? 'file-blob'
          : null,
    blobHash: operation === 'select' && table === 'file_blobs' ? params[1] ?? null : null,
    fileMutation,
    journalHead,
  }
}

function scopedFileMutationPolicy(sql, params, operation, table, session) {
  if (operation === 'select' || !['files', 'file_versions', 'file_blobs'].includes(table)) return null
  if (table === 'files' && operation === 'update') {
    throw new Error('Scoped agent sessions cannot run generic file UPDATE statements.')
  }

  const admin = agentSessionHasCapability(session, 'admin')
  if (table === 'files' && operation === 'insert') {
    const parsed = parseScopedInsert(sql)
    const knownGuarded = isKnownGuardedFileUpsert(parsed)
    if (!knownGuarded && !admin) {
      throw new Error('Scoped agent session file writes must use the guarded journal operation.')
    }
    return {
      table,
      operation,
      codebaseId: insertedBoundColumnValue(parsed, params, 'codebase_id'),
      path: insertedBoundColumnValue(parsed, params, 'path'),
      knownGuarded,
      // Storage-tally contribution for the per-tenant usage meter (Phase 3): the
      // file's byte size, from the guarded upsert's `size` column, falling back to
      // `blob_size` for R2-backed content. All guarded columns bind a single
      // anonymous param in order, so the column index is the param ordinal.
      storageBytes: knownGuarded ? guardedFileInsertStorageBytes(params) : 0,
    }
  }
  if (table === 'files' && operation === 'delete') {
    const knownGuarded = isKnownGuardedFileDelete(sql)
    if (!knownGuarded && !admin) {
      throw new Error('Scoped agent session file deletes must use the guarded journal operation.')
    }
    return {
      table,
      operation,
      codebaseId: boundPredicateValue(sql, params, 'codebase_id'),
      path: knownGuarded ? params[1] ?? null : boundPredicateValue(sql, params, 'path'),
      knownGuarded,
    }
  }
  if (table === 'file_versions' && operation === 'insert') {
    const parsed = parseScopedInsert(sql)
    const knownGuarded = isKnownGuardedFileVersionInsert(parsed)
    if (!knownGuarded && !admin) {
      throw new Error('Scoped agent session file-version writes must use the guarded journal operation.')
    }
    return {
      table,
      operation,
      path: insertedBoundColumnValue(parsed, params, 'path'),
      knownGuarded,
    }
  }
  if (!admin) {
    throw new Error('Scoped agent session file-storage mutations require admin capability.')
  }
  return {
    table,
    operation,
    path: boundPredicateValue(sql, params, 'path'),
    knownGuarded: false,
  }
}

function isOwnAgentSessionRead(sql, params, session) {
  if (/^select \* from agent_sessions where codebase_id = \? and token_hash = \? limit 1$/.test(sql)) {
    return params[0] === session?.codebase_id && params[1] === session?.token_hash
  }
  if (/^select \* from agent_sessions where codebase_id = \? and session_id = \? limit 1$/.test(sql)) {
    return params[0] === session?.codebase_id && params[1] === session?.session_id
  }
  if (/^select \* from agent_sessions where session_id = \? limit 1$/.test(sql)) {
    return params[0] === session?.session_id
  }
  return false
}

// Per-codebase settings (trail-summaries opt-in, metadata/diff mode) are
// codebase-level configuration: a privacy-posture change, not routine work
// data: so mutations require admin, matching how non-guarded codebases-row
// mutations are treated. Reads stay at read capability so agents can honor the
// opt-in. Episode rows in trail_episodes remain ordinary write-capability data.
function settingsMutationRequiresAdmin(operation, table) {
  return table === 'codebase_settings' && operation !== 'select'
}

function codebaseMutationRequiresAdmin(normalizedSql, params, operation, table) {
  if (table !== 'codebases' || operation === 'select') return false
  if (operation === 'insert' || operation === 'delete') return true

  const columns = updateColumns(normalizedSql)
  const journalHeadFormat = guardedJournalHeadFormat(normalizedSql, columns)
  if (journalHeadFormat === 'current') {
    assertCurrentGuardedJournalHead(params)
    return false
  }
  if (journalHeadFormat === 'legacy') {
    assertLegacyGuardedJournalHead(params)
    return false
  }
  return true
}

function assertCurrentGuardedJournalHead(params) {
  if (params[2] !== params[9]) {
    throw new Error('Scoped agent session guarded journal updates must preserve Main.')
  }
  assertGuardedJournalSelectedStateTransition(params)
}

function assertLegacyGuardedJournalHead(params) {
  if (params.length !== 8) {
    throw new Error('Scoped agent session legacy guarded journal updates have invalid parameters.')
  }
  const next = parseJson(params[1], null)
  const main = parseJson(params[2], null)
  if (!next || typeof next !== 'object' || !main || typeof main !== 'object') {
    throw new Error('Scoped agent session guarded journal state must be valid JSON objects.')
  }
  if (!Number.isInteger(params[0]) || !Number.isInteger(params[7]) || next.revision !== params[0] || params[0] <= params[7]) {
    throw new Error('Scoped agent session guarded journal state revisions do not match the head guard.')
  }
  if (next.type !== 'active-change-set' || !next.id || next.mergeState !== 'unmerged') {
    throw new Error('Scoped agent session guarded journal updates require an unmerged active change set.')
  }
  if (!Number.isInteger(params[3]) || params[3] < 0 || !Number.isInteger(params[4]) || params[4] < 0 || params[4] > params[3]) {
    throw new Error('Scoped agent session guarded journal file counts are invalid.')
  }
  if (typeof params[5] !== 'string' || !params[5] || typeof params[6] !== 'string' || !params[6]) {
    throw new Error('Scoped agent session legacy guarded journal guard values are invalid.')
  }
}

function assertGuardedJournalSelectedStateTransition(params) {
  const next = parseJson(params[1], null)
  const previous = parseJson(params[8], null)
  if (!next || !previous || typeof next !== 'object' || typeof previous !== 'object') {
    throw new Error('Scoped agent session guarded journal state must be valid JSON objects.')
  }
  if (next.revision !== params[0] || previous.revision !== params[7]) {
    throw new Error('Scoped agent session guarded journal state revisions do not match the head guard.')
  }
  if (previous.type !== 'active-change-set' || next.type !== 'active-change-set' || !previous.id || next.id !== previous.id) {
    throw new Error('Scoped agent session guarded journal updates require the same active change set.')
  }
  if (previous.mergeState !== 'unmerged' || next.mergeState !== 'unmerged') {
    throw new Error('Scoped agent session guarded journal updates require an unmerged change set.')
  }
  const nextWithoutRevision = { ...next }
  const previousWithoutRevision = { ...previous }
  delete nextWithoutRevision.revision
  delete previousWithoutRevision.revision
  if (stableJson(nextWithoutRevision) !== stableJson(previousWithoutRevision)) {
    throw new Error('Scoped agent session guarded journal updates may only advance selected-state revision.')
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function updateColumns(sql) {
  const match = sql.match(/^update\s+[a-z_][a-z0-9_]*\s+set\s+(.+)\s+where\s+(.+)$/)
  if (!match) return []
  return splitSqlList(match[1]).map((assignment) => assignment.match(/^([a-z_][a-z0-9_]*)\s*=/)?.[1] ?? '')
}

function guardedJournalHeadFormat(sql, columns) {
  const expectedColumns = [
    'revision',
    'selected_state_json',
    'main_json',
    'file_count',
    'private_file_count',
    'updated_at',
  ]
  if (columns.length !== expectedColumns.length || columns.some((column, index) => column !== expectedColumns[index])) return null
  if (/^update codebases set revision = \?, selected_state_json = \?, main_json = \?, file_count = \?, private_file_count = \?, updated_at = \? where codebase_id = \? and revision = \? and selected_state_json = \? and main_json = \?$/.test(sql)) {
    return 'current'
  }
  if (/^update codebases set revision = \?, selected_state_json = \?, main_json = \?, file_count = \?, private_file_count = \?, updated_at = \? where codebase_id = \? and revision = \?$/.test(sql)) {
    return 'legacy'
  }
  return null
}

function touchesAdminTable(normalizedSql) {
  return /\b(codebase_members|codebase_invitations|agent_sessions|device_keys|user_keyrings|codebase_keyrings|wrapped_keys|key_audit_events|users)\b/.test(normalizedSql)
}

function statementIsScopedToCodebase(normalizedSql, params, session) {
  const codebaseId = session?.codebase_id
  if (!codebaseId) return false
  const operation = normalizedSql.match(/^(select|insert|update|delete)\b/)?.[1]
  const table = primaryTableForStatement(normalizedSql, operation)
  if (!table || !codebaseScopedTables.has(table)) return false

  for (const ordinal of codebasePredicateParameterOrdinals(normalizedSql)) {
    if (params[ordinal] !== codebaseId) return false
  }

  if (operation === 'insert') {
    return insertedCodebaseId(normalizedSql, params) === codebaseId
  }

  if (hasDirectCodebasePredicate(normalizedSql, params, codebaseId)) return true
  return table === 'agent_sessions' && hasOwnSessionPredicate(normalizedSql, params, session.session_id)
}

const sessionUserScopedTables = new Set(['device_keys', 'user_keyrings'])

function statementIsScopedToSessionUser(normalizedSql, params, session) {
  const userId = session?.user_id
  if (!userId) return false
  const operation = normalizedSql.match(/^(select|insert|update|delete)\b/)?.[1]
  const table = primaryTableForStatement(normalizedSql, operation)
  if (!table || !sessionUserScopedTables.has(table)) return false

  if (operation === 'insert') {
    return serverActorInsertedColumnValue(normalizedSql, params, 'user_id') === userId
  }

  const matches = []
  const pattern = /\b(?:[a-z_][a-z0-9_]*\.)?user_id\s*=\s*\?/g
  for (const match of sqlCodeView(normalizedSql).matchAll(pattern)) {
    const questionIndex = match.index + match[0].lastIndexOf('?')
    matches.push(countSqlPlaceholders(normalizedSql.slice(0, questionIndex)))
  }
  return matches.length > 0 && matches.every((ordinal) => params[ordinal] === userId)
}

const codebaseScopedTables = new Set([
  'codebases',
  'files',
  'file_versions',
  'file_blobs',
  'agent_events',
  'action_jobs',
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
])

const allowedGuardSubqueryPattern = /\(\s*select 1 from codebases where codebase_id = \? and revision = \? and updated_at = \?\s*\)/g

function assertScopedSqlSyntax(normalizedSql, params) {
  const codeView = sqlCodeView(normalizedSql)
  if (/;|--|\/\*|\*\//.test(codeView)) {
    throw new Error('Scoped agent session SQL cannot contain comments or multiple statements.')
  }
  if (/\?\d+/.test(codeView)) {
    throw new Error('Scoped agent session SQL must use anonymous parameters.')
  }
  if (countSqlPlaceholders(normalizedSql) !== params.length) {
    throw new Error('Scoped agent session SQL parameter count does not match its placeholders.')
  }
  if (/\b(union|intersect|except|pragma|attach|detach|vacuum|analyze|reindex|case)\b/.test(codeView)) {
    throw new Error('Scoped agent session SQL contains unsupported syntax.')
  }
  if (/\bor\b/.test(codeView)) {
    throw new Error('Scoped agent session SQL cannot use OR predicates.')
  }
  if (/\bcodebase_id\s*(?:<>|!=|\bin\b|\bnot\s+in\b|\blike\b|\bglob\b|\bis\b)/.test(codeView)) {
    throw new Error('Scoped agent session SQL must use equality for codebase scope.')
  }
  assertOnlyAllowedSubqueries(codeView)

  const operation = codeView.match(/^(select|insert|update|delete)\b/)?.[1]
  if (operation === 'select') assertAllowedSelectShape(normalizedSql)
  if (operation === 'insert') parseScopedInsert(normalizedSql)
  if (operation === 'update') assertAllowedUpdateShape(normalizedSql)
  if (operation === 'delete') assertAllowedDeleteShape(normalizedSql)
}

function assertOnlyAllowedSubqueries(sql) {
  const withoutAllowedGuards = sql.replace(allowedGuardSubqueryPattern, '')
  if (/\(\s*select\b/.test(withoutAllowedGuards)) {
    throw new Error('Scoped agent session SQL contains an unsupported subquery.')
  }
}

function assertAllowedSelectShape(sql) {
  const match = sql.match(/^select\s+.+?\s+from\s+([a-z_][a-z0-9_]*)(?:\s+[a-z_][a-z0-9_]*)?(.*)$/)
  if (!match) throw new Error('Scoped agent session SELECT shape is not allowed.')
  const table = match[1]
  if (table === 'files') assertKnownFileSelect(sql)
  if (table === 'file_versions') assertKnownFileVersionSelect(sql)
  if (table === 'file_blobs') assertKnownFileBlobSelect(sql)
  const tail = match[2]
  const memberJoin = ' left join users u on u.user_id = m.user_id'
  const withoutAllowedMemberJoin = table === 'codebase_members' ? tail.replace(memberJoin, '') : tail
  if (/\bjoin\b/.test(withoutAllowedMemberJoin)) {
    throw new Error('Scoped agent session SQL contains an unsupported join.')
  }
  const fromClause = tail.split(/\bwhere\b|\border by\b|\blimit\b/)[0]
  if (fromClause.includes(',')) {
    throw new Error('Scoped agent session SQL contains an unsupported table list.')
  }
}

function assertKnownFileSelect(sql) {
  const allowed = [
    /^select \* from files where codebase_id = \?$/,
    /^select \* from files where codebase_id = \? order by path asc$/,
    /^select f\.\* from files f where f\.codebase_id = \? order by f\.path$/,
    /^select path from files where codebase_id = \?$/,
    /^select path from files where codebase_id = \? and path = \? limit 1$/,
  ]
  if (!allowed.some((pattern) => pattern.test(sql))) {
    throw new Error('Scoped agent session file reads must use a known operation.')
  }
}

function assertKnownFileVersionSelect(sql) {
  if (!/^select \* from file_versions where codebase_id = \? order by graph_revision asc, version_id asc$/.test(sql)) {
    throw new Error('Scoped agent session file-version reads must use a known operation.')
  }
}

function assertKnownFileBlobSelect(sql) {
  if (!/^select content, encoding, size from file_blobs where codebase_id = \? and hash = \? limit 1$/.test(sql)) {
    throw new Error('Scoped agent session file-blob reads must use a known operation.')
  }
}

function assertAllowedUpdateShape(sql) {
  const match = sql.match(/^update\s+([a-z_][a-z0-9_]*)\s+set\s+(.+)\s+where\s+(.+)$/)
  if (!match) throw new Error('Scoped agent session UPDATE shape is not allowed.')
  const assignments = splitSqlList(match[2])
  if (assignments.length === 0) throw new Error('Scoped agent session UPDATE requires assignments.')
  for (const assignment of assignments) {
    const parts = assignment.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/)
    if (!parts || parts[1] === 'codebase_id' || !allowedBoundExpression(parts[2])) {
      throw new Error('Scoped agent session UPDATE assignment is not allowed.')
    }
  }
  if (/\breturning\b/.test(match[3])) {
    throw new Error('Scoped agent session UPDATE cannot use RETURNING.')
  }
}

function assertAllowedDeleteShape(sql) {
  const match = sql.match(/^delete\s+from\s+([a-z_][a-z0-9_]*)\s+where\s+(.+)$/)
  if (!match || /\breturning\b/.test(match?.[2] ?? '')) {
    throw new Error('Scoped agent session DELETE shape is not allowed.')
  }
}

function parseScopedInsert(sql) {
  const match = sql.match(/^insert\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s+(.+)$/)
  if (!match) throw new Error('Scoped agent session INSERT shape is not allowed.')
  const columns = match[2].split(',').map((column) => column.trim())
  if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column)) || new Set(columns).size !== columns.length) {
    throw new Error('Scoped agent session INSERT columns are not allowed.')
  }

  let expressions
  let trailing
  let guarded = false
  if (match[3].startsWith('values ')) {
    const openingIndex = match[3].indexOf('(')
    const closingIndex = matchingParenthesisIndex(match[3], openingIndex)
    if (openingIndex < 0 || closingIndex < 0) throw new Error('Scoped agent session INSERT values are malformed.')
    expressions = splitSqlList(match[3].slice(openingIndex + 1, closingIndex))
    trailing = match[3].slice(closingIndex + 1).trim()
  } else {
    const selected = match[3].match(
      /^select\s+(.+?)\s+where exists\s+(\(\s*select 1 from codebases where codebase_id = \? and revision = \? and updated_at = \?\s*\))(.*)$/,
    )
    if (!selected) throw new Error('Scoped agent session INSERT SELECT shape is not allowed.')
    expressions = splitSqlList(selected[1])
    trailing = selected[3].trim()
    guarded = true
  }

  if (expressions.length !== columns.length || expressions.some((expression) => !allowedInsertExpression(expression))) {
    throw new Error('Scoped agent session INSERT values do not match its columns.')
  }
  assertAllowedConflictClause(trailing)
  return { table: match[1], columns, expressions, trailing, guarded }
}

function assertAllowedConflictClause(clause) {
  if (!clause) return
  const match = clause.match(/^on conflict\s*\(([^)]+)\)\s+do update set\s+(.+)$/)
  if (!match) throw new Error('Scoped agent session INSERT conflict clause is not allowed.')
  const conflictColumns = match[1].split(',').map((column) => column.trim())
  if (!conflictColumns.includes('codebase_id')) {
    throw new Error('Scoped agent session INSERT conflict target must include codebase_id.')
  }
  const assignments = splitSqlList(match[2])
  if (assignments.length === 0 || assignments.some((assignment) => {
    const parts = assignment.match(/^([a-z_][a-z0-9_]*)\s*=\s*excluded\.([a-z_][a-z0-9_]*)$/)
    return !parts || parts[1] === 'codebase_id' || parts[1] !== parts[2]
  })) {
    throw new Error('Scoped agent session INSERT conflict assignment is not allowed.')
  }
}

const guardedFileColumns = [
  'codebase_id',
  'path',
  'kind',
  'content',
  'encoding',
  'target',
  'blob_hash',
  'blob_provider',
  'blob_key',
  'blob_size',
  'client_encryption_json',
  'encryption_json',
  'privacy_zone',
  'zone_id',
  'content_storage',
  'hash',
  'size',
  'scope',
  'revision',
  'updated_at',
]

const guardedFileVersionColumns = [
  'codebase_id',
  'selected_state_type',
  'selected_state_id',
  'main_state_id',
  'graph_revision',
  'path',
  'operation',
  'kind',
  'old_revision',
  'new_revision',
  'old_file_json',
  'new_file_json',
  'scope',
  'privacy_zone',
  'zone_id',
  'content_storage',
  'blob_provider',
  'blob_key',
  'blob_hash',
  'encoding',
  'target',
  'size',
  'actor_user_id',
  'session_id',
  'device_name',
  'created_at',
]

// Index of a column within the guarded files upsert = its bound-param ordinal,
// because every guarded expression is a single anonymous `?` in column order.
const guardedFileSizeParamIndex = guardedFileColumns.indexOf('size')
const guardedFileBlobSizeParamIndex = guardedFileColumns.indexOf('blob_size')

function guardedFileInsertStorageBytes(params) {
  const size = Number(params[guardedFileSizeParamIndex])
  if (Number.isFinite(size) && size > 0) return size
  const blobSize = Number(params[guardedFileBlobSizeParamIndex])
  if (Number.isFinite(blobSize) && blobSize > 0) return blobSize
  return 0
}

function isKnownGuardedFileUpsert(parsed) {
  if (parsed.table !== 'files' || !parsed.guarded || !sameValues(parsed.columns, guardedFileColumns)) return false
  if (parsed.expressions.some((expression) => expression !== '?')) return false
  const conflictAssignments = guardedFileColumns
    .slice(2)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')
  return parsed.trailing === `on conflict(codebase_id, path) do update set ${conflictAssignments}`
}

function isKnownGuardedFileVersionInsert(parsed) {
  return parsed.table === 'file_versions'
    && parsed.guarded
    && sameValues(parsed.columns, guardedFileVersionColumns)
    && parsed.expressions.every((expression) => expression === '?')
    && parsed.trailing === ''
}

function isKnownGuardedFileDelete(sql) {
  return /^delete from files where codebase_id = \? and path = \? and exists \(\s*select 1 from codebases where codebase_id = \? and revision = \? and updated_at = \?\s*\)$/.test(sql)
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function insertedBoundColumnValue(parsed, params, column) {
  const columnIndex = parsed.columns.indexOf(column)
  if (columnIndex < 0 || parsed.expressions[columnIndex] !== '?') return null
  const ordinal = parsed.expressions
    .slice(0, columnIndex)
    .reduce((count, expression) => count + countSqlPlaceholders(expression), 0)
  return params[ordinal] ?? null
}

function boundPredicateValue(sql, params, column) {
  const whereIndex = sqlCodeView(sql).search(/\bwhere\b/)
  if (whereIndex < 0) return null
  const pattern = new RegExp(`\\b${column}\\s*=\\s*\\?`, 'g')
  for (const match of sqlCodeView(sql).matchAll(pattern)) {
    if (match.index <= whereIndex) continue
    const questionIndex = match.index + match[0].lastIndexOf('?')
    const ordinal = countSqlPlaceholders(sql.slice(0, questionIndex))
    return params[ordinal] ?? null
  }
  return null
}

function allowedInsertExpression(expression) {
  return expression === '?' || expression === 'null' || /^-?\d+(?:\.\d+)?$/.test(expression) || /^'(?:''|[^'])*'$/.test(expression)
}

function allowedBoundExpression(expression) {
  return allowedInsertExpression(expression)
    || /^coalesce\([a-z_][a-z0-9_]*, \?\)$/.test(expression)
    || /^[a-z_][a-z0-9_]* \+ \d+$/.test(expression)
}

function splitSqlList(value) {
  const parts = []
  let start = 0
  let depth = 0
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function matchingParenthesisIndex(value, openingIndex) {
  let depth = 0
  let quoted = false
  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index]
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function primaryTableForStatement(sql, operation) {
  if (operation === 'select') return sql.match(/\bfrom\s+([a-z_][a-z0-9_]*)\b/)?.[1] ?? null
  if (operation === 'insert') return sql.match(/^insert\s+into\s+([a-z_][a-z0-9_]*)\b/)?.[1] ?? null
  if (operation === 'update') return sql.match(/^update\s+([a-z_][a-z0-9_]*)\b/)?.[1] ?? null
  if (operation === 'delete') return sql.match(/^delete\s+from\s+([a-z_][a-z0-9_]*)\b/)?.[1] ?? null
  return null
}

function insertedCodebaseId(sql, params) {
  const { columns, expressions } = parseScopedInsert(sql)
  const columnIndex = columns.indexOf('codebase_id')
  if (columnIndex < 0 || expressions[columnIndex] !== '?') return null
  const ordinal = expressions
    .slice(0, columnIndex)
    .reduce((count, expression) => count + countSqlPlaceholders(expression), 0)
  return params[ordinal]
}

function hasDirectCodebasePredicate(sql, params, codebaseId) {
  const whereIndex = sqlCodeView(sql).search(/\bwhere\b/)
  if (whereIndex < 0) return false
  const guardRanges = allowedGuardRanges(sql)
  return codebasePredicateMatches(sql).some((match) => (
    match.index > whereIndex &&
    !guardRanges.some((range) => match.index >= range.start && match.index < range.end) &&
    params[match.ordinal] === codebaseId
  ))
}

function hasOwnSessionPredicate(sql, params, sessionId) {
  if (!sessionId) return false
  const whereIndex = sqlCodeView(sql).search(/\bwhere\b/)
  if (whereIndex < 0) return false
  const pattern = /\bsession_id\s*=\s*\?/g
  for (const match of sqlCodeView(sql).matchAll(pattern)) {
    if (match.index <= whereIndex) continue
    const questionIndex = match.index + match[0].lastIndexOf('?')
    const ordinal = countSqlPlaceholders(sql.slice(0, questionIndex))
    if (params[ordinal] === sessionId) return true
  }
  return false
}

function codebasePredicateParameterOrdinals(sql) {
  return codebasePredicateMatches(sql).map((match) => match.ordinal)
}

function codebasePredicateMatches(sql) {
  const matches = []
  const pattern = /\b(?:[a-z_][a-z0-9_]*\.)?codebase_id\s*=\s*\?/g
  for (const match of sqlCodeView(sql).matchAll(pattern)) {
    const questionIndex = match.index + match[0].lastIndexOf('?')
    matches.push({
      index: match.index,
      ordinal: countSqlPlaceholders(sql.slice(0, questionIndex)),
    })
  }
  return matches
}

function allowedGuardRanges(sql) {
  return [...sql.matchAll(allowedGuardSubqueryPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function countSqlPlaceholders(sql) {
  let count = 0
  let quoted = false
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") {
        index += 1
        continue
      }
      quoted = !quoted
    } else if (!quoted && sql[index] === '?') {
      count += 1
    }
  }
  return count
}

function sqlCodeView(sql) {
  let quoted = false
  let view = ''
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (character === "'") {
      if (quoted && sql[index + 1] === "'") {
        view += '  '
        index += 1
        continue
      }
      quoted = !quoted
      view += ' '
    } else {
      view += quoted ? ' ' : character
    }
  }
  return view
}

function agentSessionHasCapability(session, capability) {
  const capabilities = parseJson(session.capabilities_json, [])
  return Array.isArray(capabilities) && (capabilities.includes('admin') || capabilities.includes(capability))
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
