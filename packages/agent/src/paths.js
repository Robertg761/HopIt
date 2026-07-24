// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cloudServiceType, defaultSyncDebounceMs, defaultSyncMaxDelayMs, defaultWatchLimitPollIntervalMs } from './constants.js'
import { shouldUseD1Backend } from './io.js'
import { defaultWorkspaceRoot } from './options.js'
import { isPathInside, pathsOverlap } from './workspace-manifest.js'
import { d1CloudServiceType } from '@hopit/backend-d1'

// Decisions §12: "Nested cloud-sync is blocked" — two sync engines fighting over
// the same files on disk is unrecoverable, so this is a hard refusal with no
// bypass flag (unlike the other checks in assertWorkspacePathSafe below).
const CLOUD_SYNC_PROVIDERS = [
  {
    name: 'Dropbox',
    // "Dropbox", "Dropbox (Personal)", "Dropbox (Business)"
    segmentPattern: /^dropbox(\s|\(|$)/i,
    markerFiles: ['.dropbox', '.dropbox.cache'],
  },
  {
    name: 'iCloud Drive',
    // ~/Library/Mobile Documents/com~apple~CloudDocs/...
    segmentPattern: /^(mobile documents|com~apple~clouddocs)$/i,
    markerFiles: ['.icloud'],
  },
  {
    name: 'OneDrive',
    // "OneDrive", "OneDrive - Company Name"
    segmentPattern: /^onedrive(\s|-|$)/i,
    markerFiles: ['.849C9593-D756-4E56-8D6E-42412F2A707B'],
  },
  {
    name: 'Google Drive',
    // "Google Drive", "GoogleDrive", "My Drive" (Google Drive for desktop mount)
    segmentPattern: /^(google ?drive|my drive)$/i,
    markerFiles: ['.tmp.drivedownload', '.tmp.driveupload', '.googledrivefs'],
  },
]

/**
 * Detect whether `workspacePath` is inside (or itself is) a folder managed by a
 * consumer cloud-sync client (Dropbox, iCloud Drive, OneDrive, Google Drive).
 * Detection combines well-known folder-name segments with marker files/folders
 * those clients leave behind, checked at every ancestor directory. Returns the
 * provider name, or null if no nested cloud-sync folder was found.
 */
export async function detectNestedCloudSyncProvider(workspacePath) {
  const resolved = path.resolve(workspacePath)
  const segments = resolved.split(path.sep)
  for (const provider of CLOUD_SYNC_PROVIDERS) {
    if (segments.some((segment) => provider.segmentPattern.test(segment))) return provider.name
  }

  let directory = resolved
  for (;;) {
    for (const provider of CLOUD_SYNC_PROVIDERS) {
      for (const marker of provider.markerFiles) {
        if (await pathExists(path.join(directory, marker))) return provider.name
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

async function pathExists(candidate) {
  try {
    await fs.stat(candidate)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

export function cloudLocationFromOptions(options, codebaseId = options['codebase-id'] ?? null) {
  if (shouldUseD1Backend(options)) {
    return codebaseId ? `d1:${codebaseId}` : 'd1:unconfigured'
  }
  return path.resolve(options.cloud)
}

export function cloudServiceTypeFromOptions(options) {
  if (shouldUseD1Backend(options)) return d1CloudServiceType
  return cloudServiceType
}

export function remotePullEnabled(options) {
  return Boolean(options['remote-pull'] || options['auto-refresh'])
}

export function remotePushEnabled(options) {
  return Boolean(options['remote-push'])
}

export function remotePushUrl(options) {
  return options['remote-push-url'] ?? null
}

export function remoteRefreshIntervalMs(options) {
  const usesCooldownOption = options['remote-pull-cooldown-ms'] !== undefined
  const rawValue = usesCooldownOption ? options['remote-pull-cooldown-ms'] : (options['remote-refresh-interval-ms'] ?? '300000')
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 100) {
    const optionName = usesCooldownOption ? '--remote-pull-cooldown-ms' : '--remote-refresh-interval-ms'
    throw new Error(`Invalid ${optionName} value: ${rawValue}`)
  }
  return value
}

// Resolve the watch-loop coalescing window. 0 disables coalescing (restoring the
// legacy micro-debounce). Invalid/negative values are rejected so a bad env var
// can never silently change behavior.
export function syncDebounceMs(options) {
  const raw = options['sync-debounce-ms']
  if (raw === undefined || raw === null || raw === '') return defaultSyncDebounceMs
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid --sync-debounce-ms value: ${raw}. Use an integer >= 0 (0 disables coalescing).`)
  }
  return value
}

// Resolve the hard delay cap for a coalesced burst. The cap can never be shorter
// than the debounce window, or a change could be force-flushed before the quiet
// window even elapses.
export function syncMaxDelayMs(options, debounceMs = syncDebounceMs(options)) {
  const raw = options['sync-max-delay-ms']
  if (raw === undefined || raw === null || raw === '') return Math.max(defaultSyncMaxDelayMs, debounceMs)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid --sync-max-delay-ms value: ${raw}. Use an integer >= 0.`)
  }
  return Math.max(value, debounceMs)
}

// Poll cadence used once the agent has degraded to scan-only syncing because
// the OS watch limit was hit (GR-H2). Deliberately tighter than the default
// full-workspace poll interval so a watch-limit failure heals as fast as the
// generic watcher-failure fallback, even before an operator raises the limit.
export function watchLimitPollIntervalMs(options) {
  const raw = options['watch-limit-poll-interval-ms']
  if (raw === undefined || raw === null || raw === '') return defaultWatchLimitPollIntervalMs
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 100) {
    throw new Error(`Invalid --watch-limit-poll-interval-ms value: ${raw}. Use an integer >= 100.`)
  }
  return value
}

export function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

export async function assertWorkspacePathSafe(options, context = {}) {
  const workspace = path.resolve(options.workspace)

  // No bypass: decisions §12 calls nested cloud-sync "unrecoverable", so this
  // check runs even when --allow-unsafe-workspace (or --advanced) is set.
  const cloudSyncProvider = await detectNestedCloudSyncProvider(workspace)
  if (cloudSyncProvider) {
    throw new Error(
      `Refusing to place a Workspace Root inside ${cloudSyncProvider}: ${workspace}. `
        + `${cloudSyncProvider} and HopIt would both try to sync the same files, which is unrecoverable. `
        + `Choose a folder outside ${cloudSyncProvider} and let HopIt sync it instead. `
        + 'This check has no bypass.',
    )
  }

  if (options['allow-unsafe-workspace']) return

  const unsafeRoots = new Set([path.parse(workspace).root, os.homedir(), process.cwd()])
  if (unsafeRoots.has(workspace)) {
    throw new Error(`Refusing to use unsafe workspace path: ${workspace}`)
  }

  if (context.source) {
    const source = path.resolve(context.source)
    if (pathsOverlap(workspace, source)) {
      throw new Error(`Refusing workspace/source overlap: ${workspace} and ${source}`)
    }
  }

  if (options.profile === 'production') {
    const workspaceRoot = path.resolve(options['workspace-root'] ?? defaultWorkspaceRoot())
    if (!isPathInside(workspace, workspaceRoot) && workspace !== workspaceRoot) {
      throw new Error(
        `Production profile workspace must live under ${workspaceRoot}. Use --workspace-root or --allow-unsafe-workspace to override.`,
      )
    }
  }
}
