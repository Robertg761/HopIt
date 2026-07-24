// @ts-check
// Warn-only outbound secret scanner (decisions doc §7: "rotate, don't
// redact"). Scans a file's plaintext right before it is journaled/uploaded so
// the dashboard and menu bar can flag "possible secret in <path>" the moment
// it happens. Never blocks the write: callers scan, log, and continue.
//
// High-signal patterns only, tuned conservative on purpose. Outbound scanning
// runs on every synced text file, so false positives would train users to
// ignore the flag; missing an obviously-shaped credential is the worse
// failure, so the pattern list stays narrow and well-known rather than broad.
import { entryEncoding, entryKind } from './constants.js'
import { scopeForPath } from '@hopit/core/privacy-zone'

export const secretPatternKind = {
  awsAccessKeyId: 'aws-access-key-id',
  githubToken: 'github-token',
  stripeLiveSecretKey: 'stripe-live-secret-key',
  slackToken: 'slack-token',
  privateKeyPem: 'private-key-pem',
  highEntropyAssignment: 'high-entropy-assignment',
}

// Each regex is global so a single file can surface every match, and each
// pattern id is stable so events/tests can key off it without parsing labels.
const SECRET_PATTERNS = [
  {
    id: secretPatternKind.awsAccessKeyId,
    label: 'AWS access key ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: secretPatternKind.githubToken,
    label: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: secretPatternKind.stripeLiveSecretKey,
    label: 'Stripe live secret key',
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: secretPatternKind.slackToken,
    label: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: secretPatternKind.privateKeyPem,
    label: 'Private key (PEM)',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  },
]

// Only fires on a quoted-string-literal assignment whose identifier *ends*
// with a secret/token/key/password word (so `sessionToken = "…"` counts but
// `tokenContext`, `continuationToken`, or `routedSecretExists` never reach
// the regex, and a bare function call/variable on the right-hand side never
// matches because it is not wrapped in quotes). The entropy check below then
// filters out anything that is not plausibly random. This keeps the
// heuristic from tripping on ordinary identifiers, URLs, or prose that merely
// contain one of these words as a substring.
const ASSIGNMENT_LINE = /\b[A-Za-z0-9_]*?(?:secret|token|password|passwd|api[-_]?key|private[-_]?key)\b\s*[:=]\s*(['"`])([A-Za-z0-9+/=_.\-]{20,200})\1/gi

const MIN_ASSIGNMENT_ENTROPY = 3.5

export function shannonEntropy(value) {
  if (!value) return 0
  const counts = new Map()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function lineNumberAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * Scan plaintext for high-signal secret shapes. Returns a (possibly empty)
 * array of findings: `{ patternId, label, line }`. Pure and synchronous so it
 * is cheap to call on every outbound text file.
 */
export function scanTextForSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return []

  const findings = []

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0
    let match
    while ((match = pattern.regex.exec(text))) {
      findings.push({ patternId: pattern.id, label: pattern.label, line: lineNumberAt(text, match.index) })
      // Defensive: every pattern above is defined with the `g` flag, but guard
      // against an infinite loop if that ever regresses.
      if (!pattern.regex.global) break
    }
  }

  ASSIGNMENT_LINE.lastIndex = 0
  let assignmentMatch
  while ((assignmentMatch = ASSIGNMENT_LINE.exec(text))) {
    const value = assignmentMatch[2]
    if (shannonEntropy(value) >= MIN_ASSIGNMENT_ENTROPY) {
      findings.push({
        patternId: secretPatternKind.highEntropyAssignment,
        label: 'High-entropy assignment',
        line: lineNumberAt(text, assignmentMatch.index),
      })
    }
  }

  return findings
}

/**
 * Whether a journaled entry is eligible for outbound secret scanning at all:
 * a plaintext (UTF-8) file that is not under `.private/` (or `.git/`, which
 * shares the owner-private scope). Directories, symlinks, base64/binary
 * content, and owner-private paths are never scanned.
 */
export function isScannableTextEntry(relativePath, entry) {
  if (!entry || entry.kind !== entryKind.file) return false
  if (entry.encoding !== entryEncoding.utf8) return false
  if (scopeForPath(relativePath) !== 'shared') return false
  return true
}

/**
 * Findings for a single outbound file entry, or `[]` when the entry is not
 * scannable or has no matches.
 */
export function secretFindingsForEntry(relativePath, entry) {
  if (!isScannableTextEntry(relativePath, entry)) return []
  return scanTextForSecrets(typeof entry.content === 'string' ? entry.content : '')
}
