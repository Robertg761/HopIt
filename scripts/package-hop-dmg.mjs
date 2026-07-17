#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import appdmg from 'appdmg'

import { packageTargets, parseTargets } from './package-hop.mjs'
import { buildDesktopApp } from '../packages/desktop/scripts/package-desktop.mjs'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const artifactsRoot = path.join(repoRoot, 'artifacts')
const MAC_TARGETS = ['darwin-arm64', 'darwin-x64']
const DMG_BACKGROUND = path.join(repoRoot, 'packages', 'desktop', 'assets', 'dmg', 'HopIt-dmg-background.png')

export async function buildMacDmg({ built, version = localVersion() }) {
  assertMacPackages(built)
  requireMacTool('hdiutil')

  const dmgPath = path.join(artifactsRoot, 'HopIt-macOS.dmg')
  const checksumPath = `${dmgPath}.sha256`

  const desktop = await buildDesktopApp({ built })
  await fs.rm(dmgPath, { force: true })
  await createDmg({
    target: dmgPath,
    specification: buildDmgSpecification({ appPath: desktop.appPath }),
  })

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
}

export function buildDmgSpecification({ appPath }) {
  return {
    title: 'HopIt',
    icon: path.join(repoRoot, 'packages', 'desktop', 'assets', 'HopIt.icns'),
    background: DMG_BACKGROUND,
    'icon-size': 128,
    window: {
      position: { x: 180, y: 120 },
      size: { width: 660, height: 420 },
    },
    contents: [
      { x: 170, y: 235, type: 'file', path: appPath },
      { x: 490, y: 235, type: 'link', path: '/Applications' },
    ],
  }
}

function assertMacPackages(built) {
  for (const target of MAC_TARGETS) {
    const result = built.find((entry) => entry.target === target)
    if (!result?.releaseRoot) throw new Error(`Missing packaged runtime for ${target}.`)
  }
}

function requireMacTool(tool) {
  const result = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${tool} is required to build a macOS disk image.`)
}

function createDmg({ target, specification }) {
  return new Promise((resolve, reject) => {
    const emitter = appdmg({ target, basepath: repoRoot, specification })
    emitter.once('finish', resolve)
    emitter.once('error', reject)
  })
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
