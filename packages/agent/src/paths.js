// @ts-check
import os from 'node:os'
import path from 'node:path'
import { cloudServiceType, defaultSyncDebounceMs, defaultSyncMaxDelayMs } from './constants.js'
import { shouldUseD1Backend } from './io.js'
import { defaultWorkspaceRoot } from './options.js'
import { isPathInside, pathsOverlap } from './workspace-manifest.js'
import { d1CloudServiceType } from '@hopit/backend-d1'

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

export function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

export async function assertWorkspacePathSafe(options, context = {}) {
  if (options['allow-unsafe-workspace']) return

  const workspace = path.resolve(options.workspace)
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
