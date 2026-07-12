// The prompt/response CONTRACT lives here, not in the vendor adapters, so
// switching models is a config change rather than a code change — and, crucially,
// the metadata-vs-diff privacy boundary is enforced at this single point.
//
// Metadata mode sends ONLY paths / counts / timestamps / device. There is no
// code path here that can place file contents into a metadata payload: the diff
// text is a separate argument that is dropped unless mode === 'diff'.

export const DEFAULT_DIFF_MAX_CHARS = 8000
export const MAX_LABEL_TOKENS = 25

/**
 * Build the exact object that will be serialized to the model. This is also
 * what `--dry-run` prints for privacy inspection.
 */
export function buildEpisodePayload(episode, { mode = 'metadata', diffText = null, diffMaxChars = DEFAULT_DIFF_MAX_CHARS } = {}) {
  const base = {
    mode: mode === 'diff' ? 'diff' : 'metadata',
    device: episode.deviceName ?? null,
    fromRevision: episode.fromRevision ?? null,
    toRevision: episode.toRevision ?? null,
    startedAt: episode.startedAt ?? null,
    endedAt: episode.endedAt ?? null,
    stepCount: episode.stepCount ?? 0,
    changedPathCount: episode.changedPathCount ?? 0,
    samplePaths: Array.isArray(episode.samplePaths) ? episode.samplePaths : [],
  }
  if (base.mode === 'diff') {
    base.diff = boundDiff(diffText, diffMaxChars)
  }
  return base
}

// A terse instruction: one short line, trail vocabulary, no git/commit metaphors.
const SYSTEM_PROMPT = [
  'You label one episode from a project\'s trail — a run of edits from one device.',
  'Write ONE terse line (at most 25 tokens) describing what the work touched.',
  'Use plain trail vocabulary. Do NOT use commit/PR/branch metaphors or the words',
  '"commit", "commit message", "changelog". No trailing punctuation. Output only the label.',
].join(' ')

/**
 * Build the {system, user} prompt pair from a payload. Kept adapter-agnostic:
 * the OpenAI adapter maps it to `messages`, the Gemini adapter maps it to
 * `contents`, and both share this identical contract.
 */
export function buildPrompt(payload) {
  return {
    system: SYSTEM_PROMPT,
    user: `Episode metadata (JSON):\n${JSON.stringify(payload, null, 2)}\n\nLabel:`,
  }
}

// Model output is untrusted free text; clamp it to a single terse line so a
// verbose or multi-line response can never blow past the label budget.
export function sanitizeLabel(text) {
  const firstLine = String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const stripped = firstLine.replace(/^["'`]+|["'`]+$/g, '').replace(/[.\s]+$/g, '').trim()
  const words = stripped.split(/\s+/).filter(Boolean)
  return words.slice(0, MAX_LABEL_TOKENS).join(' ')
}

function boundDiff(diffText, diffMaxChars) {
  if (typeof diffText !== 'string' || diffText.length === 0) return ''
  const max = Number.isInteger(diffMaxChars) && diffMaxChars > 0 ? diffMaxChars : DEFAULT_DIFF_MAX_CHARS
  if (diffText.length <= max) return diffText
  return `${diffText.slice(0, max)}\n… [diff truncated to ${max} chars]`
}
