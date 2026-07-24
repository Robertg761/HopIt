import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { d1SchemaStatements } from '../../backend-d1/src/schema.js'
import { diffSchemas, parseSchema, splitSqlFile } from './helpers/schema-sql.js'

// Guards against `cloudflare/d1/schema.sql` (the reference file used to
// provision a fresh D1 database) drifting from `packages/backend-d1/src/
// schema.js` (the runtime source of truth applied by `ensureSchema`). The two
// must agree on table names, column names (including columns added via
// `alter table ... add column`), and index names, or a fresh database
// provisioned from schema.sql will silently diverge from what the running
// agent/worker expects.

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaSqlPath = path.join(here, '..', '..', '..', 'cloudflare', 'd1', 'schema.sql')

test('cloudflare/d1/schema.sql matches packages/backend-d1/src/schema.js (no drift)', async () => {
  const sqlText = await fs.readFile(schemaSqlPath, 'utf8')
  const sqlStatements = splitSqlFile(sqlText)

  const fromSql = parseSchema(sqlStatements)
  const fromJs = parseSchema(d1SchemaStatements)

  assert.ok(fromSql.tables.size > 0, 'expected schema.sql to declare at least one table')
  assert.ok(fromJs.tables.size > 0, 'expected schema.js to declare at least one table')

  const problems = diffSchemas(fromJs, fromSql, 'schema.js', 'schema.sql')
  assert.deepEqual(
    problems,
    [],
    `schema.sql has drifted from schema.js:\n${problems.join('\n')}`,
  )
})

test('drift guard: parseSchema/diffSchemas detects an intentionally removed column', () => {
  // This is the metric demonstration: prove the guard actually fails when one
  // side loses a column, not just that it passes on the current (in-sync)
  // files.
  const withColumn = parseSchema([
    `create table if not exists widgets (
      widget_id text primary key,
      name text not null
    )`,
  ])
  const withoutColumn = parseSchema([
    `create table if not exists widgets (
      widget_id text primary key
    )`,
  ])

  const problems = diffSchemas(withColumn, withoutColumn, 'left', 'right')
  assert.deepEqual(problems, ['column "widgets.name" present in left but missing from right'])
})

test('drift guard: parseSchema/diffSchemas detects an intentionally removed table', () => {
  const withTable = parseSchema([
    `create table if not exists widgets (widget_id text primary key)`,
    `create table if not exists gadgets (gadget_id text primary key)`,
  ])
  const withoutTable = parseSchema([
    `create table if not exists widgets (widget_id text primary key)`,
  ])

  const problems = diffSchemas(withTable, withoutTable, 'left', 'right')
  assert.deepEqual(problems, ['table "gadgets" present in left but missing from right'])
})

test('drift guard: parseSchema/diffSchemas detects a missing index', () => {
  const withIndex = parseSchema([
    `create table if not exists widgets (widget_id text primary key, name text)`,
    `create index if not exists idx_widgets_name on widgets(name)`,
  ])
  const withoutIndex = parseSchema([
    `create table if not exists widgets (widget_id text primary key, name text)`,
  ])

  const problems = diffSchemas(withIndex, withoutIndex, 'left', 'right')
  assert.deepEqual(problems, ['index "idx_widgets_name" present in left but missing from right'])
})
