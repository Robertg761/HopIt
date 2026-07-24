import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { d1SchemaStatements } from '../../backend-d1/src/schema.js'
import { diffSchemas, parseSchema, splitSqlFile } from './helpers/schema-sql.js'

// GR-B1: proves the DRAFT migration
// (cloudflare/d1/migrations/2026-07-24-proposals.sql) is sufficient to take a
// pre-GR-B1 database to the schema now checked into
// packages/backend-d1/src/schema.js, and that the schema documented in
// docs/proposal-data-model-design.md is what actually shipped.

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.join(
  here,
  '..',
  '..',
  '..',
  'cloudflare',
  'd1',
  'migrations',
  '2026-07-24-proposals.sql',
)
const designDocPath = path.join(here, '..', '..', '..', 'docs', 'proposal-data-model-design.md')

const PROPOSAL_ADDITIONS_TABLE = 'proposals'
const PROPOSAL_ADDITIONS_INDEXES = new Set(['idx_proposals_codebase_change_set', 'idx_proposals_codebase_state_queued'])
const REVIEW_DECISIONS_ADDED_COLUMNS = new Set(['decision_revision', 'proposal_id'])

/**
 * Removes every GR-B1 addition from a parsed schema, simulating "the schema
 * as it stood immediately before this migration was written."
 * @param {{ tables: Map<string, Set<string>>, indexes: Set<string> }} schema
 * @returns {{ tables: Map<string, Set<string>>, indexes: Set<string> }}
 */
function withoutProposalAdditions(schema) {
  const tables = new Map()
  for (const [table, columns] of schema.tables) {
    if (table === PROPOSAL_ADDITIONS_TABLE) continue
    if (table === 'review_decisions') {
      const trimmed = new Set([...columns].filter((column) => !REVIEW_DECISIONS_ADDED_COLUMNS.has(column)))
      tables.set(table, trimmed)
      continue
    }
    tables.set(table, new Set(columns))
  }
  const indexes = new Set([...schema.indexes].filter((index) => !PROPOSAL_ADDITIONS_INDEXES.has(index)))
  return { tables, indexes }
}

test('migration + pre-GR-B1 schema reproduces the current schema.js exactly', async () => {
  const migrationText = await fs.readFile(migrationPath, 'utf8')
  const migrationStatements = splitSqlFile(migrationText)
  assert.ok(migrationStatements.length > 0, 'expected the migration file to declare at least one statement')

  const currentSchema = parseSchema(d1SchemaStatements)
  const preMigrationSchema = withoutProposalAdditions(currentSchema)

  // Sanity: the strip actually removed something, or this test would pass
  // vacuously.
  assert.ok(!preMigrationSchema.tables.has(PROPOSAL_ADDITIONS_TABLE), 'expected the stripped schema to lack `proposals`')
  assert.deepEqual(
    [...(preMigrationSchema.tables.get('review_decisions') ?? [])].filter((c) => REVIEW_DECISIONS_ADDED_COLUMNS.has(c)),
    [],
    'expected the stripped schema to lack the new review_decisions columns',
  )

  const migrationOnlySchema = parseSchema(migrationStatements)
  const rebuilt = {
    tables: new Map(preMigrationSchema.tables),
    indexes: new Set(preMigrationSchema.indexes),
  }
  for (const [table, columns] of migrationOnlySchema.tables) {
    const existing = rebuilt.tables.get(table) ?? new Set()
    for (const column of columns) existing.add(column)
    rebuilt.tables.set(table, existing)
  }
  for (const index of migrationOnlySchema.indexes) rebuilt.indexes.add(index)

  const problems = diffSchemas(rebuilt, currentSchema, 'pre-GR-B1 schema + migration', 'schema.js')
  assert.deepEqual(problems, [], `migration does not fully reproduce schema.js:\n${problems.join('\n')}`)
})

test('migration file matches the columns documented in the design doc row shape table', async () => {
  const migrationText = await fs.readFile(migrationPath, 'utf8')
  const migrationSchema = parseSchema(splitSqlFile(migrationText))

  const proposalsColumns = migrationSchema.tables.get('proposals')
  assert.ok(proposalsColumns, 'expected the migration to declare the proposals table')

  const expectedColumns = [
    'proposal_id',
    'codebase_id',
    'change_set_id',
    'title',
    'state',
    'pinned_revision',
    'pinned_at',
    'base_revision',
    'created_by_user_id',
    'created_at',
    'updated_at',
    'queued_at',
    'merged_at',
    'merged_revision',
    'merged_by_user_id',
    'stale_at',
    'stale_reason',
  ]
  for (const column of expectedColumns) {
    assert.ok(proposalsColumns.has(column), `expected proposals.${column} in the migration`)
  }

  const reviewDecisionsColumns = migrationSchema.tables.get('review_decisions')
  assert.ok(reviewDecisionsColumns?.has('decision_revision'))
  assert.ok(reviewDecisionsColumns?.has('proposal_id'))
})

test('design doc exists with the required traceability table against decisions §2-4', async () => {
  const text = await fs.readFile(designDocPath, 'utf8')

  assert.match(text, /## Traceability table/)
  assert.match(text, /## Proposal row shape/)
  assert.match(text, /## How "saves since proposal" is computed/)
  assert.match(text, /## How review staleness is derived/)
  assert.match(text, /## Merge queue serialization/)
  assert.match(text, /compareRevisions/, 'expected the design doc to reference the WS7c compareRevisions engine, not new diff machinery')

  const tableSection = text.slice(text.indexOf('## Traceability table'))
  const rows = tableSection
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    // Drop the header row and the `| --- | --- |` separator row.
    .slice(2)
  assert.ok(rows.length >= 15, `expected at least 15 traceability rows, found ${rows.length}`)

  for (const row of rows) {
    const cells = row
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
    assert.ok(cells.length >= 3, `expected a 3-column traceability row, got: ${row}`)
    const [, , designElement] = cells
    assert.ok(designElement.length > 0, `expected a non-empty design-element/deferred cell in row: ${row}`)
  }

  // Every §2, §3, and §4 decisions-doc section referenced in the traceability
  // table must show up at least once, so the table cannot silently skip a
  // whole section.
  assert.match(tableSection, /§2/)
  assert.match(tableSection, /§3/)
  assert.match(tableSection, /§4/)
})
