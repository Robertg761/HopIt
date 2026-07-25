// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Files and folders that mark a directory as a recognizable project. These drive
 * whether a candidate is SELECTED by default, never whether it is listed: every
 * top-level folder is offered, because a folder worth syncing does not have to
 * carry a manifest.
 */
const projectSignals = [
  { marker: '.git', label: 'git' },
  { marker: 'package.json', label: 'node' },
  { marker: 'Cargo.toml', label: 'rust' },
  { marker: 'go.mod', label: 'go' },
  { marker: 'pyproject.toml', label: 'python' },
  { marker: 'requirements.txt', label: 'python' },
  { marker: 'Gemfile', label: 'ruby' },
  { marker: 'composer.json', label: 'php' },
  { marker: 'pom.xml', label: 'maven' },
  { marker: 'build.gradle', label: 'gradle' },
  { marker: 'build.gradle.kts', label: 'gradle' },
  { marker: 'CMakeLists.txt', label: 'cmake' },
  { marker: 'Makefile', label: 'make' },
  { marker: 'pubspec.yaml', label: 'dart' },
  { marker: 'Package.swift', label: 'swift' },
  { marker: '*.xcodeproj', label: 'xcode' },
  { marker: '*.sln', label: 'dotnet' },
]

/**
 * Folder names that are never a project of their own: they are dependency or
 * build output directories that happen to live at the top level of some layouts.
 * They stay listed (the user asked for every top-level folder) but never
 * pre-selected, so a stray node_modules cannot ride along with "Select all".
 */
const neverPreselected = new Set([
  'node_modules', 'vendor', 'venv', '.venv', 'dist', 'build', 'out', 'target',
  '__pycache__', '.cache', '.next', '.turbo', '.gradle', 'Pods', 'DerivedData',
])

/**
 * Enumerate every immediate subdirectory of `directory` as a candidate project.
 *
 * Inclusion is deliberately broad. Signals only decide `recommended`, which the
 * caller uses for default selection, so an un-versioned folder of notes is still
 * offered -- it just is not checked for you.
 *
 * Hidden folders are the one exception to "list everything": a bare `.cache` or
 * `.config` is noise rather than a project, so they are listed only when they
 * carry a project signal of their own.
 *
 * @param {string} directory
 * @returns {Promise<Array<{name: string, source: string, signals: string[], recommended: boolean}>>}
 */
export async function scanProjectCandidates(directory) {
  const root = path.resolve(directory)
  const stat = await fs.stat(root).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Scan source is not a directory: ${root}`)
  }

  const entries = await fs.readdir(root, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = path.join(root, entry.name)
    const signals = await detectProjectSignals(source)
    if (entry.name.startsWith('.') && signals.length === 0) continue
    candidates.push({
      name: entry.name,
      source,
      signals,
      recommended: signals.length > 0 && !neverPreselected.has(entry.name),
    })
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name))
}

/** @param {string} source */
async function detectProjectSignals(source) {
  const names = await fs.readdir(source).catch(() => null)
  if (!names) return []
  const present = new Set(names)
  const signals = new Set()
  for (const { marker, label } of projectSignals) {
    if (marker.startsWith('*.')) {
      const suffix = marker.slice(1)
      if (names.some((name) => name.endsWith(suffix))) signals.add(label)
      continue
    }
    if (present.has(marker)) signals.add(label)
  }
  return [...signals]
}
