#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { packageTargets, parseTargets } from './package-hop.mjs'
import { buildDesktopApp } from '../packages/desktop/scripts/package-desktop.mjs'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const artifactsRoot = path.join(repoRoot, 'artifacts')
const MAC_TARGETS = ['darwin-arm64', 'darwin-x64']

export async function buildMacDmg({ built, version = localVersion() }) {
  assertMacPackages(built)
  requireMacTool('hdiutil')

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-dmg-'))
  const volumeRoot = path.join(stagingRoot, 'HopIt')
  const dmgPath = path.join(artifactsRoot, 'HopIt-macOS.dmg')
  const checksumPath = `${dmgPath}.sha256`

  try {
    const desktop = await buildDesktopApp({ built })
    await fs.mkdir(volumeRoot, { recursive: true })
    copyMacBundle(desktop.appPath, path.join(volumeRoot, 'HopIt.app'))
    await fs.symlink('/Applications', path.join(volumeRoot, 'Applications'))
    await fs.writeFile(path.join(volumeRoot, 'README.txt'), renderDmgReadme(), 'utf8')

    await fs.rm(dmgPath, { force: true })
    const create = spawnSync('hdiutil', [
      'create',
      '-volname', 'HopIt',
      '-srcfolder', volumeRoot,
      '-format', 'UDZO',
      '-imagekey', 'zlib-level=9',
      '-ov',
      dmgPath,
    ], { cwd: repoRoot, encoding: 'utf8' })
    if (create.status !== 0) {
      throw new Error(`Unable to create HopIt DMG: ${create.stderr || create.stdout}`)
    }

    const verify = spawnSync('hdiutil', ['verify', dmgPath], { cwd: repoRoot, encoding: 'utf8' })
    if (verify.status !== 0) {
      throw new Error(`HopIt DMG verification failed: ${verify.stderr || verify.stdout}`)
    }

    const sha256 = await sha256File(dmgPath)
    await fs.writeFile(checksumPath, `${sha256}  ${path.basename(dmgPath)}\n`, 'utf8')
    const stat = await fs.stat(dmgPath)

    return {
      fileName: path.basename(dmgPath),
      dmgPath,
      checksumPath,
      sha256,
      size: stat.size,
      version,
      verified: true,
      appPath: desktop.appPath,
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

export function renderDmgReadme() {
  return `HopIt for macOS

1. Drag HopIt into the Applications folder.
2. Open HopIt from Applications.
3. Add a project and approve this Mac when HopIt opens your browser.

HopIt is a universal app for Apple silicon and Intel Macs. It includes the
matching agent runtime inside the application, so Node, npm, and a separate
terminal installer are not required.

This build is not signed or notarized yet. If macOS blocks the first launch,
Control-click HopIt in Applications, choose Open, then confirm Open.
`
}

function assertMacPackages(built) {
  for (const target of MAC_TARGETS) {
    const result = built.find((entry) => entry.target === target)
    if (!result?.releaseRoot) throw new Error(`Missing packaged runtime for ${target}.`)
  }
}

function requireMacTool(tool) {
  const result = spawnSync(tool, ['help'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${tool} is required to build a macOS disk image.`)
}

function copyMacBundle(source, destination) {
  const result = spawnSync('ditto', ['--rsrc', '--extattr', '--acl', source, destination], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`Unable to stage HopIt.app: ${result.stderr || result.stdout}`)
  }
}

function localVersion() {
  const pkg = JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout)
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`Unable to resolve git revision: ${git.stderr || git.stdout}`)
  return `${pkg.version}+${git.stdout.trim()}`
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

async function main() {
  const skipPackage = process.argv.includes('--skip-package')
  const targets = parseTargets({ argv: ['--target', MAC_TARGETS.join(',')], env: {} })
  const built = skipPackage
    ? MAC_TARGETS.map((target) => ({
      target,
      packageName: `hop-${target}`,
      releaseRoot: path.join(artifactsRoot, `hop-${target}`),
    }))
    : await packageTargets(targets)
  const dmg = await buildMacDmg({ built })
  console.log(JSON.stringify({ ok: true, dmg }, null, 2))
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await main()
