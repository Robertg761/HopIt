#!/usr/bin/env node
// Package the HopIt desktop app as a universal macOS application. Both agent
// runtimes are copied into the completed app bundle after Electron's universal
// merge so the app can run without a separate CLI installation.

import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import { packager } from '@electron/packager'

import { packageTargets, parseTargets } from '../../../scripts/package-hop.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')
const outDir = path.join(repoRoot, 'artifacts', 'desktop')
const MAC_TARGETS = ['darwin-arm64', 'darwin-x64']

export async function buildDesktopApp({ built = null, version = localDesktopVersion(), builtAt = new Date().toISOString(), gitSha = null } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('The universal HopIt desktop app must be packaged on macOS.')
  }

  const packagedRuntimes = built ?? await packageTargets(parseTargets({
    argv: ['--target', MAC_TARGETS.join(',')],
    env: {},
  }))
  assertMacPackages(packagedRuntimes)

  await fs.mkdir(outDir, { recursive: true })
  const appPaths = await packager({
    dir: desktopRoot,
    name: 'HopIt',
    out: outDir,
    overwrite: true,
    platform: 'darwin',
    arch: 'universal',
    asar: true,
    osxUniversal: { mergeASARs: true },
    appBundleId: 'dev.hopit.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    icon: path.join(desktopRoot, 'assets', 'HopIt.icns'),
    // Keep the artifact lean: only the app source and manifest are needed.
    ignore: [
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/assets($|\/)/,
      /^\/node_modules\/@electron($|\/)/,
      /^\/node_modules\/electron($|\/)/,
      /^\/node_modules\/\.bin($|\/)/,
    ],
    prune: true,
  })

  if (appPaths.length !== 1) {
    throw new Error(`Expected one universal desktop package, received ${appPaths.length}.`)
  }
  const appPath = path.join(appPaths[0], 'HopIt.app')
  const agentResources = path.join(appPath, 'Contents', 'Resources', 'agent')
  await fs.mkdir(agentResources, { recursive: true })
  for (const target of MAC_TARGETS) {
    const runtime = packagedRuntimes.find((entry) => entry.target === target)
    await fs.cp(runtime.releaseRoot, path.join(agentResources, runtime.packageName), { recursive: true })
  }

  await fs.writeFile(path.join(appPath, 'Contents', 'Resources', 'update-info.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    builtAt,
    gitSha,
    channel: 'latest',
  }, null, 2)}\n`, 'utf8')

  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    encoding: 'utf8',
  })
  if (sign.status !== 0) {
    throw new Error(`Unable to apply the macOS ad hoc signature: ${sign.stderr || sign.stdout}`)
  }

  return { appPath, architecture: 'universal', adHocSigned: true, signed: false, notarized: false }
}

function localDesktopVersion() {
  const pkg = JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout)
  return `${pkg.version}+dev`
}

function assertMacPackages(built) {
  for (const target of MAC_TARGETS) {
    const runtime = built.find((entry) => entry.target === target)
    if (!runtime?.releaseRoot || !runtime?.packageName) {
      throw new Error(`Missing packaged runtime for ${target}.`)
    }
  }
}

async function main() {
  const result = await buildDesktopApp()
  console.log(JSON.stringify({ ok: true, desktop: result }, null, 2))
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
