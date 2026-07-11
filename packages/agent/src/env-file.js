// @ts-check
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { isTruthyEnv } from './paths.js'

// Default location of the deployed production env file. `hop setup --connect`
// writes it here (see writeConnectedEnvFile) and the launchd/systemd services
// load it with `set -a; . <file>; set +a`. Autoloading it inside the CLI lets a
// plain `hop status` / `hop add` work without the user manually sourcing it.
export function defaultEnvFilePath() {
  return path.join(os.homedir(), '.config', 'hopit', 'production.env')
}

// Resolve which env file to autoload, honoring $HOPIT_ENV_FILE. Returns null when
// autoload is disabled or no file exists (a silent no-op for the dev checkout).
export function resolveEnvFilePath(env = process.env) {
  if (isTruthyEnv(env.HOPIT_NO_ENV_FILE)) return null
  const explicit = env.HOPIT_ENV_FILE
  if (explicit && explicit.trim()) {
    const resolved = path.resolve(expandTilde(explicit.trim(), env))
    return existsSync(resolved) ? resolved : null
  }
  const fallback = defaultEnvFilePath()
  return existsSync(fallback) ? fallback : null
}

function expandTilde(value, env) {
  const home = env.HOME || os.homedir()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

// Expand the $VAR / ${VAR} / ${VAR:-default} subset that the deployed env files
// actually use (e.g. `$HOME/HopIt Workspaces`, `${XDG_STATE_HOME:-$HOME/.local/state}`).
// Expansion resolves against `scope` (process.env overlaid with values parsed so
// far in this same file), matching how `. file` evaluates lines in order.
export function expandShellValue(value, scope) {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      // Preserve an escaped character literally (\$ -> $, \" -> ").
      out += value[i + 1]
      i += 1
      continue
    }
    if (ch !== '$') {
      out += ch
      continue
    }
    const rest = value.slice(i + 1)
    // ${VAR}, ${VAR:-default}, ${VAR-default}
    const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/.exec(rest)
    if (braced) {
      const name = braced[1]
      const current = scope[name]
      if (current !== undefined && current !== '') {
        out += current
      } else if (braced[2] !== undefined) {
        out += expandShellValue(braced[2], scope)
      }
      i += braced[0].length
      continue
    }
    // $VAR
    const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (bare) {
      out += scope[bare[0]] ?? ''
      i += bare[0].length
      continue
    }
    out += ch
  }
  return out
}

// Parse the supported subset of `set -a`-style env files into an ordered array of
// [key, value] pairs. Supports: blank lines, full-line and trailing `#` comments,
// optional `export ` prefix, single-quoted (literal) values, double-quoted values
// (with $VAR expansion and backslash escapes), and unquoted values (with $VAR
// expansion). Values may reference variables set earlier in the same file or in
// the surrounding environment. Unsupported constructs (command substitution,
// arithmetic, multi-line quotes spanning newlines) are intentionally not handled;
// setup writes only the supported subset.
export function parseEnvFile(content, baseEnv = process.env) {
  const pairs = []
  const scope = { ...baseEnv }
  const lines = String(content).split(/\r?\n/)
  for (const rawLine of lines) {
    let line = rawLine
    const trimmedStart = line.replace(/^\s+/, '')
    if (trimmedStart === '' || trimmedStart.startsWith('#')) continue
    line = trimmedStart
    if (line.startsWith('export ')) line = line.slice('export '.length).replace(/^\s+/, '')

    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    const raw = line.slice(eq + 1)
    const value = parseValue(raw, scope)
    scope[key] = value
    pairs.push([key, value])
  }
  return pairs
}

function parseValue(raw, scope) {
  const first = raw[0]
  if (first === '"') {
    const end = findClosingQuote(raw, '"')
    const inner = end === -1 ? raw.slice(1) : raw.slice(1, end)
    return expandShellValue(inner, scope)
  }
  if (first === "'") {
    // Single quotes are fully literal in sh; no expansion, no escapes.
    const end = raw.indexOf("'", 1)
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }
  // Unquoted: strip a trailing ` # comment`, trim, then expand.
  const stripped = raw.replace(/\s+#.*$/, '').trim()
  return expandShellValue(stripped, scope)
}

// Find the closing double quote, skipping backslash-escaped quotes.
function findClosingQuote(raw, quote) {
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      i += 1
      continue
    }
    if (raw[i] === quote) return i
  }
  return -1
}

// Apply parsed pairs to process.env WITHOUT overriding variables already present.
// Explicit environment (and therefore flags derived from it) always wins. Returns
// the list of keys actually applied, for observability/tests.
export function applyEnvPairs(pairs, env = process.env) {
  const applied = []
  for (const [key, value] of pairs) {
    if (env[key] === undefined) {
      env[key] = value
      applied.push(key)
    }
  }
  return applied
}

// Autoload the deployed production env file into process.env early in CLI startup.
// Silent no-op when disabled ($HOPIT_NO_ENV_FILE), when no file exists, or when the
// file cannot be read. Never throws — a bad env file must not break the CLI.
export function autoloadEnvFile(env = process.env) {
  try {
    const filePath = resolveEnvFilePath(env)
    if (!filePath) return { loaded: false, path: null, applied: [] }
    const content = readFileSync(filePath, 'utf8')
    const pairs = parseEnvFile(content, env)
    const applied = applyEnvPairs(pairs, env)
    return { loaded: true, path: filePath, applied }
  } catch {
    return { loaded: false, path: null, applied: [] }
  }
}
