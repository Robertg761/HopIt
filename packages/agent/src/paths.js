// @ts-check
import os from 'node:os'
import path from 'node:path'
import { cloudServiceType } from './constants.js'
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

