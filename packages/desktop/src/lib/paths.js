// @ts-check
// State-root, workspace-index, and hop-binary discovery for the desktop shell.
//
// The state-root / workspace-root helpers are tiny reimplementations of
// defaultAgentStateRoot / defaultWorkspaceRoot from packages/agent/src/options.js
// and workspaceIndexPath from packages/agent/src/workspace-index.js, kept here so
// the Electron main process does not import the agent's heavy module graph. Keep
// them in lockstep with the agent if those defaults ever change.

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'

/** Mirrors packages/agent/src/options.js defaultAgentStateRoot. */
export function defaultAgentStateRoot(env = process.env, platform = process.platform) {
  if (env.HOPIT_AGENT_STATE_ROOT) return env.HOPIT_AGENT_STATE_ROOT
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HopIt', 'Agent')
  }
  if (platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'HopIt',
      'Agent',
    )
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'hopit', 'agent')
}

/** Mirrors packages/agent/src/options.js defaultWorkspaceRoot. */
export function defaultWorkspaceRoot(env = process.env) {
  return env.HOPIT_WORKSPACE_ROOT ?? path.join(os.homedir(), 'HopIt Workspaces')
}

/** Mirrors packages/agent/src/workspace-index.js workspaceIndexPath. */
export function workspaceIndexPath(stateRoot) {
  return path.join(stateRoot, 'workspaces.json')
}

/** Per-codebase connection store directory (packages/agent/src/connections.js). */
export function connectionsDir(stateRoot) {
  return path.join(stateRoot, 'connections')
}

/**
 * Ordered candidate locations for the installed `hop` launcher. The runtime
 * path is the packaged binary installed by support/install-macos-launch-agent.sh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 */
export function hopBinaryCandidates(env = process.env, platform = process.platform) {
  const home = os.homedir()
  const candidates = []
  // Explicit override always wins (useful for dev against a repo checkout).
  if (env.HOPIT_HOP_BIN) candidates.push(env.HOPIT_HOP_BIN)
  candidates.push(path.join(home, '.local', 'bin', 'hop'))
  candidates.push('/opt/homebrew/bin/hop')
  candidates.push('/usr/local/bin/hop')
  // Packaged runtime layouts under Application Support.
  const arch = platform === 'darwin' ? (process.arch === 'x64' ? 'x64' : 'arm64') : process.arch
  if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'HopIt', 'Runtime', `hop-darwin-${arch}`, 'bin', 'hop'),
    )
  } else {
    candidates.push(
      path.join(home, '.local', 'share', 'hopit', 'runtime', `hop-linux-${arch}`, 'bin', 'hop'),
    )
  }
  return candidates
}

/**
 * Resolve the first existing `hop` binary. `fileExists` is injectable so the
 * resolver is pure/testable; it defaults to fs.existsSync.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, fileExists?: (p: string) => boolean }} [deps]
 * @returns {string|null}
 */
export function resolveHopBinary(deps = {}) {
  const { env = process.env, platform = process.platform, fileExists = existsSync } = deps
  for (const candidate of hopBinaryCandidates(env, platform)) {
    if (candidate && fileExists(candidate)) return candidate
  }
  return null
}

/** Resolve the agent runtime embedded in a packaged universal macOS app. */
export function bundledHopBinary(resourcesPath, arch = process.arch, platform = process.platform) {
  if (platform !== 'darwin' || typeof resourcesPath !== 'string' || resourcesPath.trim() === '') return null
  const runtimeArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!runtimeArch) return null
  return path.join(resourcesPath, 'agent', `hop-darwin-${runtimeArch}`, 'bin', 'hop')
}

/**
 * Validate an absolute directory path received over IPC before it is handed to
 * shell.openPath or `hop add`. Rejects relative paths, null bytes, and other
 * obvious traversal/injection shapes. Returns the normalized absolute path or
 * throws.
 * @param {unknown} candidate
 */
export function assertSafeAbsolutePath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('A path is required.')
  }
  const value = candidate.trim()
  if (value.includes('\0')) throw new Error('Path contains a null byte.')
  if (!path.isAbsolute(value)) throw new Error(`Path must be absolute: ${value}`)
  const normalized = path.normalize(value)
  return normalized
}

/**
 * Validate an absolute path that must stay *inside* a trusted root directory.
 * Used when the target is built by joining a trusted root (a project's workspace
 * folder) with an untrusted, disk/cloud-derived subpath (a file path from the
 * agent's status map): a hostile subpath like `../../../../etc/passwd` normalizes
 * to an absolute path outside the root, so a plain absolute-path check would still
 * let it through. Returns the normalized absolute target or throws.
 * @param {unknown} root
 * @param {unknown} candidate
 */
export function assertPathWithin(root, candidate) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('A valid root directory is required.')
  }
  const target = assertSafeAbsolutePath(candidate)
  const normalizedRoot = path.normalize(root)
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep
  if (target !== normalizedRoot && !target.startsWith(rootWithSep)) {
    throw new Error(`Path escapes its project folder: ${target}`)
  }
  return target
}

/**
 * A codebase id must be a single safe path segment (matches the agent's
 * assertSafeConnectionCodebaseId contract).
 * @param {unknown} candidate
 */
export function assertSafeCodebaseId(candidate) {
  const value = typeof candidate === 'string' ? candidate.trim() : ''
  if (!value) throw new Error('Codebase id is required.')
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error(`Unsafe codebase id: ${candidate}`)
  }
  return value
}
