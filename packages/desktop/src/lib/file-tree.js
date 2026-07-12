// @ts-check
// Translate the agent's per-file cache state (the /status `workspace.files` map)
// into a friendly, plain-language file browser model. Every badge is derived
// strictly from the agent's own fields — when a field is absent we say so ("—")
// rather than guess. The directory listing is built one level at a time so the
// UI can lazily expand folders instead of shipping thousands of nodes at once.
//
// Per-file fields the agent exposes (see packages/agent status endpoint):
//   exists, hydrated, state, pinned, dirty, pending, blocked, prunable,
//   bytesOnDisk, lastHydratedAt, lastEditedAt, lastSyncedAt

/** @typedef {{code:string,label:string,tone:string}} Badge */

/**
 * Plain-language badge for one file entry. Priority: issue > editing/syncing >
 * on-this-Mac vs cloud-only. `pinned` is reported separately as a flag.
 * @param {any} entry
 * @returns {Badge}
 */
export function translateFileBadge(entry) {
  if (!entry || typeof entry !== 'object') return { code: 'unknown', label: '—', tone: 'muted' }
  if (entry.blocked || entry.state === 'blocked') return { code: 'issue', label: 'Issue', tone: 'danger' }
  if (entry.dirty || entry.state === 'dirty') return { code: 'editing', label: 'Editing… syncing', tone: 'active' }
  if (entry.pending || entry.state === 'pending') return { code: 'syncing', label: 'Syncing…', tone: 'active' }
  if (entry.hydrated || entry.state === 'hydrated' || entry.state === 'uploaded') {
    return { code: 'local', label: 'On this Mac', tone: 'ok' }
  }
  if (entry.state === 'cloud-only' || entry.hydrated === false) {
    return { code: 'cloud', label: 'Cloud only', tone: 'muted' }
  }
  return { code: 'unknown', label: '—', tone: 'muted' }
}

/** Priority order for aggregating a folder's mixed child states. */
const AGG_PRIORITY = ['issue', 'editing', 'syncing', 'cloud', 'local', 'unknown']

/**
 * Build a single directory listing (immediate children only) from the full files
 * map, scoped to `subpath` ('' = workspace root).
 * @param {Record<string, any>} filesMap
 * @param {{ subpath?: string }} [opts]
 */
export function buildDirectoryListing(filesMap, opts = {}) {
  const subpath = normalizeSubpath(opts.subpath ?? '')
  const prefix = subpath ? `${subpath}/` : ''
  /** @type {Map<string, any>} */
  const folders = new Map()
  const files = []

  for (const [fullPath, entry] of Object.entries(filesMap ?? {})) {
    if (prefix && !fullPath.startsWith(prefix)) continue
    const relative = fullPath.slice(prefix.length)
    if (!relative) continue
    const slash = relative.indexOf('/')
    if (slash === -1) {
      const badge = translateFileBadge(entry)
      files.push({
        name: relative,
        path: fullPath,
        type: 'file',
        badge,
        pinned: Boolean(entry?.pinned),
        prunable: Boolean(entry?.prunable),
        bytesOnDisk: typeof entry?.bytesOnDisk === 'number' ? entry.bytesOnDisk : null,
        lastHydratedAt: entry?.lastHydratedAt ?? null,
        lastSyncedAt: entry?.lastSyncedAt ?? null,
      })
    } else {
      const folderName = relative.slice(0, slash)
      const folderPath = prefix + folderName
      if (!folders.has(folderName)) {
        folders.set(folderName, {
          name: folderName,
          path: folderPath,
          type: 'folder',
          counts: { local: 0, cloud: 0, syncing: 0, editing: 0, issue: 0, unknown: 0, pinned: 0, total: 0 },
        })
      }
      const folder = folders.get(folderName)
      const badge = translateFileBadge(entry)
      folder.counts[badge.code] = (folder.counts[badge.code] ?? 0) + 1
      folder.counts.total += 1
      if (entry?.pinned) folder.counts.pinned += 1
    }
  }

  const folderList = [...folders.values()].map((folder) => ({
    ...folder,
    badge: aggregateFolderBadge(folder.counts),
  }))
  folderList.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))

  return { path: subpath, folders: folderList, files, empty: folderList.length === 0 && files.length === 0 }
}

/** Fold per-code counts into a representative folder badge. */
export function aggregateFolderBadge(counts) {
  for (const code of AGG_PRIORITY) {
    if (counts[code] > 0) {
      switch (code) {
        case 'issue':
          return { code: 'issue', label: `${counts.issue} issue`, tone: 'danger' }
        case 'editing':
        case 'syncing':
          return { code: 'syncing', label: 'Syncing…', tone: 'active' }
        case 'cloud':
          // Mixed or fully cloud-only.
          return counts.local > 0
            ? { code: 'mixed', label: `${counts.local}/${counts.total} on this Mac`, tone: 'muted' }
            : { code: 'cloud', label: 'Cloud only', tone: 'muted' }
        case 'local':
          return { code: 'local', label: 'On this Mac', tone: 'ok' }
        default:
          return { code: 'unknown', label: '—', tone: 'muted' }
      }
    }
  }
  return { code: 'unknown', label: '—', tone: 'muted' }
}

function normalizeSubpath(subpath) {
  return String(subpath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}
