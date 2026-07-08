// @ts-check
import path from 'node:path'
import { defaultSiblingHydrationMaxBytes, defaultSiblingHydrationMaxFiles } from '../constants.js'
import { normalizeCloudFileEntry } from '../journal.js'
import { parseNonNegativeIntegerOption, selectedCloudPaths } from '../workspace-index.js'

export function selectedHydrationPathsForCommand(cloud, requestedPath, options, command) {
  const directPaths = selectedCloudPaths(cloud, requestedPath, { recursive: command.recursive })
  if (!command.withSiblings) {
    return {
      paths: directPaths,
      budgetReason: null,
    }
  }

  const maxFiles = parseNonNegativeIntegerOption(options['sibling-max-files'], defaultSiblingHydrationMaxFiles)
  const maxBytes = parseNonNegativeIntegerOption(options['sibling-max-bytes'], defaultSiblingHydrationMaxBytes)
  return buildSiblingHydrationPlan(cloud, directPaths[0], {
    maxFiles,
    maxBytes,
  })
}

export function buildOpenHydrationPlan(cloud, indexedCodebase, budget) {
  const candidates = prioritizedOpenHydrationCandidates(cloud, indexedCodebase, budget)
  return boundedHydrationPlan(candidates, budget)
}

export function prioritizedOpenHydrationCandidates(cloud, indexedCodebase, budget) {
  const files = Object.entries(cloud.files ?? {}).map(([relativePath, file]) => ({
    path: relativePath,
    entry: normalizeCloudFileEntry(relativePath, file),
  }))
  const candidates = []

  for (const file of files.filter((file) => isRootMetadataHydrationPath(file.path))) {
    candidates.push({ ...file, group: 'root-metadata' })
  }

  if (cloud.selectedState?.type === 'active-change-set') {
    for (const file of files
      .filter((file) => !isRootMetadataHydrationPath(file.path))
      .sort(compareCloudEntriesByRecency)) {
      candidates.push({ ...file, group: 'recent-active-change-set' })
    }
  }

  const pinnedPaths = new Set(Object.entries(indexedCodebase?.localCache?.files ?? {})
    .filter(([, entry]) => entry?.pinned)
    .map(([relativePath]) => relativePath))
  for (const file of files.filter((file) => pinnedPaths.has(file.path))) {
    candidates.push({ ...file, group: 'pinned' })
  }

  for (const file of files.filter((file) =>
    isSmallCommonSourceFile(file.path, file.entry, budget.smallFileBytes) &&
    !isRootMetadataHydrationPath(file.path) &&
    !pinnedPaths.has(file.path)
  )) {
    candidates.push({ ...file, group: 'small-source' })
  }

  return candidates
}

export function buildSiblingHydrationPlan(cloud, requestedPath, budget) {
  const directPath = selectedCloudPaths(cloud, requestedPath, { recursive: false })[0]
  if (!isCommonSourcePath(directPath)) {
    return {
      paths: [directPath],
      budgetReason: null,
    }
  }

  const folder = path.posix.dirname(directPath)
  const candidates = Object.entries(cloud.files ?? {})
    .filter(([relativePath, file]) => {
      const entry = normalizeCloudFileEntry(relativePath, file)
      return relativePath === directPath || (path.posix.dirname(relativePath) === folder && entry.kind !== 'directory')
    })
    .sort(([a], [b]) => {
      if (a === directPath) return -1
      if (b === directPath) return 1
      return a.localeCompare(b)
    })
    .map(([relativePath, file]) => ({
      path: relativePath,
      entry: normalizeCloudFileEntry(relativePath, file),
      group: 'source-sibling',
    }))

  const plan = boundedHydrationPlan(candidates, budget)
  if (!plan.paths.includes(directPath)) plan.paths.unshift(directPath)
  return plan
}

export function boundedHydrationPlan(candidates, budget) {
  const paths = []
  const seen = new Set()
  let bytes = 0
  let hitFileLimit = false
  let hitByteLimit = false

  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)

    const size = candidate.entry.size ?? 0
    if (paths.length >= budget.maxFiles) {
      hitFileLimit = true
      continue
    }
    if (bytes + size > budget.maxBytes) {
      hitByteLimit = true
      continue
    }

    paths.push(candidate.path)
    bytes += size
  }

  return {
    paths,
    bytes,
    consideredPathCount: seen.size,
    budgetReason: hitFileLimit && hitByteLimit
      ? 'max_files_and_max_bytes'
      : hitFileLimit
        ? 'max_files'
        : hitByteLimit
          ? 'max_bytes'
          : null,
  }
}

function compareCloudEntriesByRecency(first, second) {
  const firstTime = timestampScore(first.entry.updatedAt)
  const secondTime = timestampScore(second.entry.updatedAt)
  if (firstTime !== secondTime) return secondTime - firstTime
  return (second.entry.revision ?? 0) - (first.entry.revision ?? 0) || first.path.localeCompare(second.path)
}

function timestampScore(value) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function isRootMetadataHydrationPath(relativePath) {
  const parts = relativePath.split('/')
  const basename = parts.at(-1) ?? relativePath
  const lower = basename.toLowerCase()
  if (parts.length === 1) {
    if (lower.startsWith('readme')) return true
    if ([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'tsconfig.json',
      'jsconfig.json',
      'pyproject.toml',
      'requirements.txt',
      'cargo.toml',
      'cargo.lock',
      'go.mod',
      'go.sum',
      'gemfile',
      'gemfile.lock',
      'composer.json',
      'composer.lock',
      'pom.xml',
      'build.gradle',
      'settings.gradle',
      'dockerfile',
      'makefile',
      '.editorconfig',
      '.gitignore',
    ].includes(lower)) return true
    if (/^(eslint|prettier|vite|next|tailwind|postcss|rollup|webpack)\.config\./.test(lower)) return true
  }

  return parts.length === 2 &&
    parts[0] === '.vscode' &&
    ['settings.json', 'extensions.json', 'launch.json', 'tasks.json'].includes(lower)
}

function isSmallCommonSourceFile(relativePath, entry, smallFileBytes) {
  return entry.kind !== 'directory' &&
    entry.size <= smallFileBytes &&
    isCommonSourcePath(relativePath)
}

function isCommonSourcePath(relativePath) {
  const root = relativePath.split('/')[0]
  return new Set([
    'src',
    'app',
    'lib',
    'components',
    'pages',
    'server',
    'packages',
    'test',
    'tests',
  ]).has(root)
}
