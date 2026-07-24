import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { d1SchemaStatements } from '../../backend-d1/src/schema.js'

// Guards against `cloudflare/d1/schema.sql` (the reference file used to
// provision a fresh D1 database) drifting from `packages/backend-d1/src/
// schema.js` (the runtime source of truth applied by `ensureSchema`). The two
// must agree on table names, column names (including columns added via
// `alter table ... add column`), and index names, or a fresh database
// provisioned from schema.sql will silently diverge from what the running
// agent/worker expects.

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaSqlPath = path.join(here, '..', '..', '..', 'cloudflare', 'd1', 'schema.sql')

/**
 * Splits a batch of SQL statements into top-level statements. Handles both
 * the `schema.js` array form (statements already split, no trailing `;`) and
 * a flat `.sql` file form (statements separated by `;`, with `--` line
 * comments and blank lines to strip).
 * @param {string} sqlText
 * @returns {string[]}
 */
function splitSqlFile(sqlText) {
  const withoutComments = sqlText
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/**
 * Splits the inner content of a parenthesized column list on top-level
 * commas, ignoring commas nested inside `(...)` (e.g. `primary key (a, b)`).
 * @param {string} inner
 * @returns {string[]}
 */
function splitTopLevel(inner) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts
}

const NON_COLUMN_KEYWORDS = new Set([
  'primary',
  'foreign',
  'unique',
  'check',
  'constraint',
])

/**
 * Parses a batch of raw SQL statements into a structural summary: table
 * names mapped to their column-name sets (including `alter table add
 * column` additions), and the set of index names declared.
 * @param {string[]} statements
 * @returns {{ tables: Map<string, Set<string>>, indexes: Set<string> }}
 */
function parseSchema(statements) {
  const tables = new Map()
  const indexes = new Set()

  for (const raw of statements) {
    const statement = raw.trim()
    if (!statement) continue
    const normalized = statement.replace(/\s+/g, ' ').trim()

    const createTableMatch = normalized.match(
      /^create table if not exists (\w+)\s*\((.*)\)$/i,
    )
    if (createTableMatch) {
      const [, tableName, body] = createTableMatch
      const columns = new Set()
      for (const part of splitTopLevel(body)) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
        if (NON_COLUMN_KEYWORDS.has(firstWord)) continue
        columns.add(firstWord)
      }
      tables.set(tableName, columns)
      continue
    }

    const alterMatch = normalized.match(
      /^alter table (\w+) add column (\w+)/i,
    )
    if (alterMatch) {
      const [, tableName, columnName] = alterMatch
      if (!tables.has(tableName)) tables.set(tableName, new Set())
      tables.get(tableName).add(columnName.toLowerCase())
      continue
    }

    const indexMatch = normalized.match(
      /^create index if not exists (\w+) on (\w+)/i,
    )
    if (indexMatch) {
      const [, indexName] = indexMatch
      indexes.add(indexName)
      continue
    }

    throw new Error(`schema-drift test cannot parse statement: ${normalized.slice(0, 80)}`)
  }

  return { tables, indexes }
}

/**
 * Diffs two parsed schemas and returns a human-readable list of mismatches
 * (empty when the schemas agree).
 * @param {{ tables: Map<string, Set<string>>, indexes: Set<string> }} left
 * @param {{ tables: Map<string, Set<string>>, indexes: Set<string> }} right
 * @param {string} leftName
 * @param {string} rightName
 * @returns {string[]}
 */
function diffSchemas(left, right, leftName, rightName) {
  const problems = []

  const leftTables = new Set(left.tables.keys())
  const rightTables = new Set(right.tables.keys())
  for (const table of leftTables) {
    if (!rightTables.has(table)) {
      problems.push(`table "${table}" present in ${leftName} but missing from ${rightName}`)
    }
  }
  for (const table of rightTables) {
    if (!leftTables.has(table)) {
      problems.push(`table "${table}" present in ${rightName} but missing from ${leftName}`)
    }
  }

  for (const table of leftTables) {
    if (!rightTables.has(table)) continue
    const leftCols = left.tables.get(table)
    const rightCols = right.tables.get(table)
    for (const col of leftCols) {
      if (!rightCols.has(col)) {
        problems.push(`column "${table}.${col}" present in ${leftName} but missing from ${rightName}`)
      }
    }
    for (const col of rightCols) {
      if (!leftCols.has(col)) {
        problems.push(`column "${table}.${col}" present in ${rightName} but missing from ${leftName}`)
      }
    }
  }

  for (const idx of left.indexes) {
    if (!right.indexes.has(idx)) {
      problems.push(`index "${idx}" present in ${leftName} but missing from ${rightName}`)
    }
  }
  for (const idx of right.indexes) {
    if (!left.indexes.has(idx)) {
      problems.push(`index "${idx}" present in ${rightName} but missing from ${leftName}`)
    }
  }

  return problems
}

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
