// Shared SQL-shape parsing used by the GR-S1 schema-drift guard
// (`packages/agent/test/schema-drift.test.js`) and the GR-B1 migration
// consistency check (`packages/agent/test/proposal-schema-design.test.js`).
// Deliberately dumb: it understands exactly the statement shapes this repo's
// schema files use (`create table if not exists`, `alter table ... add
// column`, `create index if not exists`) and throws on anything else, so an
// unrecognized statement fails loud instead of being silently skipped.

/**
 * Splits a batch of SQL statements into top-level statements. Handles both
 * the `schema.js` array form (statements already split, no trailing `;`) and
 * a flat `.sql` file form (statements separated by `;`, with `--` line
 * comments and blank lines to strip).
 * @param {string} sqlText
 * @returns {string[]}
 */
export function splitSqlFile(sqlText) {
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

const NON_COLUMN_KEYWORDS = new Set(['primary', 'foreign', 'unique', 'check', 'constraint'])

/**
 * Parses a batch of raw SQL statements into a structural summary: table
 * names mapped to their column-name sets (including `alter table add
 * column` additions), and the set of index names declared.
 * @param {string[]} statements
 * @returns {{ tables: Map<string, Set<string>>, indexes: Set<string> }}
 */
export function parseSchema(statements) {
  const tables = new Map()
  const indexes = new Set()

  for (const raw of statements) {
    const statement = raw.trim()
    if (!statement) continue
    const normalized = statement.replace(/\s+/g, ' ').trim()

    const createTableMatch = normalized.match(/^create table if not exists (\w+)\s*\((.*)\)$/i)
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

    const alterMatch = normalized.match(/^alter table (\w+) add column (\w+)/i)
    if (alterMatch) {
      const [, tableName, columnName] = alterMatch
      if (!tables.has(tableName)) tables.set(tableName, new Set())
      tables.get(tableName).add(columnName.toLowerCase())
      continue
    }

    const indexMatch = normalized.match(/^create index if not exists (\w+) on (\w+)/i)
    if (indexMatch) {
      const [, indexName] = indexMatch
      indexes.add(indexName)
      continue
    }

    throw new Error(`schema parser cannot parse statement: ${normalized.slice(0, 80)}`)
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
export function diffSchemas(left, right, leftName, rightName) {
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
