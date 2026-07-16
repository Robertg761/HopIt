// @ts-check
import path from 'node:path'
import { isTruthyEnv } from './paths.js'

// Shared human/JSON output layer for the CLI. Bulk commands (add/import/mirror/
// sync/hydrate) historically streamed one raw NDJSON event line to stdout per
// journaled write: thousands of `write.journaled ...` lines for a real import.
// This module renders concise, styled human progress instead, while `--json` /
// `HOPIT_JSON=1` restores the exact raw event stream that machine consumers and
// the test suite depend on. The events journal file still records everything.

const color = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  teal: '[38;5;44m',
  green: '[38;5;42m',
  amber: '[38;5;214m',
  red: '[38;5;203m',
}

// `--json` / `HOPIT_JSON=1` forces the raw machine output regardless of command.
export function jsonForced(options = {}) {
  return Boolean(options?.json) || isTruthyEnv(process.env.HOPIT_JSON)
}

// Human mode renders concise, styled progress. It is opt-in per command
// (cli.js sets `_humanOutput` on the user-facing one-shot commands) so daemons
// (`watch`, `service run`) and structured queries keep today's raw event stream.
export function humanOutputMode(options = {}) {
  if (jsonForced(options)) return false
  return Boolean(options?._humanOutput)
}

// True when output should be the raw NDJSON/JSON machine form (the inverse of
// human mode). Used to no-op the live reporter outside human commands.
export function jsonOutputMode(options = {}) {
  return !humanOutputMode(options)
}

export function supportsColor(stream = process.stderr) {
  return Boolean(stream && stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb')
}

function paint(value, code) {
  if (!supportsColor(process.stderr)) return String(value)
  return `${code}${value}${color.reset}`
}

export const bold = (v) => paint(v, color.bold)
export const muted = (v) => paint(v, color.dim)
export const accent = (v) => paint(v, color.teal)
export const success = (v) => paint(v, color.green)
export const caution = (v) => paint(v, color.amber)
export const danger = (v) => paint(v, color.red)

// All human-facing output goes to stderr, matching the setup wizard, so stdout
// stays clean (empty in human mode, machine JSON in --json mode).
export function writeLine(message = '') {
  process.stderr.write(`${message}\n`)
}

// ---------------------------------------------------------------------------
// Live bulk-progress reporter (module singleton: one CLI invocation = one run).
// ---------------------------------------------------------------------------

const reporter = {
  activePhase: null, // { label, count, total }
  ttyDirty: false, // a carriage-return line is pending a newline
}

function progressStream() {
  return process.stderr
}

function isTty() {
  return Boolean(process.stderr.isTTY)
}

function renderActive(final = false) {
  const phase = reporter.activePhase
  if (!phase) return
  const counter = phase.total
    ? `${phase.count}/${phase.total}`
    : String(phase.count)
  const label = `  ${accent('•')} ${phase.label} ${muted(counter)}`
  if (isTty()) {
    progressStream().write(`\r[2K${label}${final ? '\n' : ''}`)
    reporter.ttyDirty = !final
  } else if (final) {
    progressStream().write(`${label}\n`)
  }
  // Non-TTY intermediate frames are throttled by the caller (see bumpPhase).
}

function finishActivePhase() {
  if (!reporter.activePhase) return
  renderActive(true)
  reporter.activePhase = null
  reporter.ttyDirty = false
}

// Register (or reset) the total for the next bulk phase keyed by its label. Called
// by commands that know the count up front so progress can render `X/N`.
export function beginBulkPhase(options, label, total = null) {
  if (jsonOutputMode(options) || options?.quiet) return
  if (reporter.activePhase && reporter.activePhase.label !== label) finishActivePhase()
  reporter.activePhase = { label, count: 0, total: Number.isFinite(total) ? total : null }
}

function bumpPhase(label, total = null) {
  if (!reporter.activePhase || reporter.activePhase.label !== label) {
    finishActivePhase()
    reporter.activePhase = { label, count: 0, total: Number.isFinite(total) ? total : null }
  }
  reporter.activePhase.count += 1
  if (isTty()) {
    renderActive(false)
  } else if (reporter.activePhase.count % 200 === 0) {
    // Piped/non-TTY: occasional plain progress lines, never carriage returns.
    progressStream().write(`  ${reporter.activePhase.label} ${reporter.activePhase.count}\n`)
  }
}

// Flush any in-progress counter. Call before printing a summary or exiting.
export function finishReporter(options = {}) {
  if (jsonOutputMode(options) || options?.quiet) return
  finishActivePhase()
}

// ---------------------------------------------------------------------------
// Event -> human policy
// ---------------------------------------------------------------------------

// Per-entry events that drive a single live counter instead of one line each.
// `cloud.acknowledged` is deliberately excluded: it interleaves with
// `write.journaled` in the non-bulk path and would flip-flop the phase label.
const BULK_PHASES = {
  'file.hydrated': 'Materializing files…',
  'write.journaled': 'Journaling changes…',
}

function basename(p) {
  try {
    return path.basename(String(p))
  } catch {
    return String(p)
  }
}

// Render a single event as human progress (only reached in human, non-quiet mode).
export function reportEvent(options, event, detail = {}) {
  if (BULK_PHASES[event]) {
    bumpPhase(BULK_PHASES[event])
    return
  }

  switch (event) {
    case 'cloud.initialized':
      finishActivePhase()
      writeLine(`  ${success('✓')} Initialized cloud graph${muted(`: ${detail.files ?? 0} files`)}`)
      break
    case 'local.imported':
      finishActivePhase()
      writeLine(`  ${success('✓')} Imported ${detail.files ?? 0} files ${muted(`from ${basename(detail.source)}`)}`)
      break
    case 'import.exists':
      finishActivePhase()
      writeLine(`  ${caution('○')} Already imported ${muted('(pass --force to replace)')}`)
      break
    case 'git.clone_complete':
      finishActivePhase()
      writeLine(`  ${success('✓')} Cloned repository`)
      break
    case 'sync.started':
      finishActivePhase()
      writeLine(`  ${accent('•')} Scanning workspace for changes…`)
      break
    case 'sync.complete': {
      finishActivePhase()
      const writes = detail.writes ?? detail.committed ?? null
      writeLine(`  ${success('✓')} Sync complete${writes != null ? muted(`: ${writes} change${writes === 1 ? '' : 's'}`) : ''}`)
      break
    }
    case 'workspace.ready':
      finishActivePhase()
      writeLine(
        `  ${success('✓')} Workspace ready${muted(`: ${detail.materializedFileCount ?? 0} new, ${detail.verifiedFileCount ?? 0} unchanged (rev ${detail.revision ?? '?'})`)}`,
      )
      break
    case 'workspace.attached':
      finishActivePhase()
      writeLine(`  ${success('✓')} Workspace attached ${muted(basename(detail.workspace ?? ''))}`)
      break
    case 'mirror.complete':
      finishActivePhase()
      writeLine(`  ${success('✓')} Mirror complete`)
      break
    case 'refresh.complete':
      finishActivePhase()
      writeLine(`  ${success('✓')} Refreshed from cloud ${muted(`(rev ${detail.revision ?? '?'})`)}`)
      break
    // Surfaced failures/blocks always show, even in the concise view.
    case 'mirror.failed':
    case 'sync.failed':
    case 'refresh.blocked':
    case 'journal.recovery_failed':
      finishActivePhase()
      writeLine(`  ${danger('✗')} ${event.replace(/\./g, ' ')} ${muted(detail.reason ?? '')}`)
      break
    default:
      // Everything else is recorded to the journal and available under --json;
      // stay silent to keep the human view concise.
      break
  }
}

// Print a command's final result: raw JSON under --json, or a caller-supplied
// concise human summary otherwise. Always flushes any pending progress counter.
export function reportResult(options, result, humanSummary) {
  finishReporter(options)
  if (!humanOutputMode(options)) {
    // Preserve the exact JSON summary machine consumers / tests parse today.
    console.log(JSON.stringify(result, null, 2))
    return
  }
  // A sub-command invoked inside another command (e.g. mirror within add) should
  // not print its own human summary; only the top-level command summarizes.
  if (options?.internal) return
  if (typeof humanSummary === 'function') {
    humanSummary({ line: writeLine, accent, muted, success, caution, danger, bold })
  }
}
