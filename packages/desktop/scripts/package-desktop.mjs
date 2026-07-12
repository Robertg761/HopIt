#!/usr/bin/env node
// Package the HopIt desktop app as an UNSIGNED local dogfood artifact under
// <repo>/artifacts/desktop/. This is intentionally NOT wired into any release
// publication flow — signing/notarization are still blocked repo-wide, matching
// the CLI. Uses @electron/packager (devDependency of this workspace only), so
// the agent runtime packaging (scripts/package-hop.mjs) is untouched.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { packager } from '@electron/packager'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')
const outDir = path.join(repoRoot, 'artifacts', 'desktop')

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const appPaths = await packager({
    dir: desktopRoot,
    name: 'HopIt',
    out: outDir,
    overwrite: true,
    // Current platform/arch only: this is a local dogfood build, not a release.
    platform: process.platform,
    arch: process.arch,
    appBundleId: 'dev.hopit.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    // Keep the artifact lean: only the app source and manifest are needed.
    ignore: [
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/node_modules\/@electron($|\/)/,
      /^\/node_modules\/electron($|\/)/,
      /^\/node_modules\/\.bin($|\/)/,
    ],
    prune: true,
  })
  for (const appPath of appPaths) {
    console.log(`Packaged (unsigned, local dogfood): ${appPath}`)
  }
  console.log('Note: this artifact is unsigned. Do not publish it; signing/notarization are still pending.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
