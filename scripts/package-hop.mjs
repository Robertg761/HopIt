#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const nodeVersion = process.env.HOP_PACKAGE_NODE_VERSION ?? process.version
const target = targetFromProcess()
const packageName = `hop-${target.nodePlatform}-${target.nodeArch}`
const artifactsRoot = path.join(repoRoot, 'artifacts')
const cacheRoot = path.join(artifactsRoot, 'cache')
const releaseRoot = path.join(artifactsRoot, packageName)
const runtimeRoot = path.join(releaseRoot, 'runtime')
const appRoot = path.join(releaseRoot, 'app')
const fixtureRoot = path.join(appRoot, 'fixtures')
const binRoot = path.join(releaseRoot, 'bin')
const archivePath = path.join(artifactsRoot, `${packageName}.tar.gz`)
const bundledCliPath = path.join(appRoot, 'hop.mjs')
const runtimeNodePath = path.join(runtimeRoot, target.exeName)

await fs.rm(releaseRoot, { recursive: true, force: true })
await fs.mkdir(cacheRoot, { recursive: true })
await fs.mkdir(runtimeRoot, { recursive: true })
await fs.mkdir(fixtureRoot, { recursive: true })
await fs.mkdir(binRoot, { recursive: true })

const officialNodePath = await ensureOfficialNodeRuntime()
await copyExecutable(officialNodePath, runtimeNodePath)

await build({
  entryPoints: [path.join(repoRoot, 'packages/agent/src/cli.js')],
  outfile: bundledCliPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  legalComments: 'none',
})
await fs.chmod(bundledCliPath, 0o755)

await fs.copyFile(
  path.join(repoRoot, 'packages/agent/fixtures/demo-cloud.json'),
  path.join(fixtureRoot, 'demo-cloud.json'),
)
await writeLauncher()
await writeReadme()
await writeManifest()
await verifyRelease()
await createArchive()

console.log(JSON.stringify({
  ok: true,
  packageName,
  releaseRoot,
  archivePath,
  nodeVersion,
  target,
}, null, 2))

function targetFromProcess() {
  const platformMap = {
    darwin: 'darwin',
    linux: 'linux',
  }
  const archMap = {
    arm64: 'arm64',
    x64: 'x64',
  }

  if (process.platform === 'win32') {
    throw new Error(
      'Windows packaging is not supported yet. Official Node Windows runtimes ship as .zip archives, while this packager currently handles macOS/Linux .tar.gz runtimes.',
    )
  }

  const nodePlatform = platformMap[process.platform]
  const nodeArch = archMap[process.arch]

  if (!nodePlatform || !nodeArch) {
    throw new Error(`Unsupported packaging target: ${process.platform}-${process.arch}`)
  }

  return {
    platform: process.platform,
    arch: process.arch,
    nodePlatform,
    nodeArch,
    exeName: 'node',
    launcherName: 'hop',
  }
}

async function ensureOfficialNodeRuntime() {
  const nodeDirName = `node-${nodeVersion}-${target.nodePlatform}-${target.nodeArch}`
  const extractedRoot = path.join(cacheRoot, nodeDirName)
  const extractedNodePath = path.join(extractedRoot, 'bin', target.exeName)

  if (await isExecutable(extractedNodePath)) return extractedNodePath

  const archiveName = `${nodeDirName}.tar.gz`
  const downloadUrl = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`
  const downloadPath = path.join(cacheRoot, archiveName)

  await downloadFile(downloadUrl, downloadPath)
  await extractTarball(downloadPath, cacheRoot)

  if (!(await isExecutable(extractedNodePath))) {
    throw new Error(`Downloaded Node runtime did not contain ${extractedNodePath}`)
  }

  return extractedNodePath
}

async function downloadFile(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }

  const writer = createWriteStream(destination)
  await new Promise((resolve, reject) => {
    response.body.pipeTo(new WritableStream({
      write(chunk) {
        writer.write(Buffer.from(chunk))
      },
      close() {
        writer.end(resolve)
      },
      abort(error) {
        writer.destroy(error)
        reject(error)
      },
    })).catch(reject)
  })
}

async function extractTarball(archive, destination) {
  const result = spawnSync('tar', ['-xzf', archive, '-C', destination], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(`Failed to extract ${archive}: ${result.stderr || result.stdout}`)
  }
}

async function copyExecutable(source, destination) {
  await fs.copyFile(source, destination)
  await fs.chmod(destination, 0o755)
}

async function writeLauncher() {
  await fs.writeFile(
    path.join(binRoot, target.launcherName),
    `#!/bin/sh
set -eu
SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SELF_DIR/../runtime/node" "$SELF_DIR/../app/hop.mjs" "$@"
`,
    'utf8',
  )
  await fs.chmod(path.join(binRoot, target.launcherName), 0o755)
}

async function writeReadme() {
  await fs.writeFile(
    path.join(releaseRoot, 'README.txt'),
    `HopIt standalone command

Run:
  ./bin/hop help
  ./bin/hop import --profile production --source /path/to/project --codebase-id my-project --force
  ./bin/hop service start --profile production --codebase-id my-project
  ./bin/hop service status --profile production --codebase-id my-project
  ./bin/hop export --output /path/to/export
  ./bin/hop publish --output /path/to/publish

This package includes its own Node runtime, so Node and npm are not required on
the target machine. It is not signed or notarized yet.
`,
    'utf8',
  )
}

async function writeManifest() {
  const manifest = {
    name: 'hop',
    version: readPackageJson().version,
    nodeVersion,
    target,
    createdAt: new Date().toISOString(),
    files: {
      launcher: `bin/${target.launcherName}`,
      runtime: `runtime/${target.exeName}`,
      app: 'app/hop.mjs',
      fixture: 'app/fixtures/demo-cloud.json',
    },
    checksums: {
      app: await sha256File(bundledCliPath),
      runtime: await sha256File(runtimeNodePath),
    },
  }

  await fs.writeFile(path.join(releaseRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function readPackageJson() {
  return JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout)
}

async function verifyRelease() {
  const launcherPath = path.join(binRoot, target.launcherName)
  const helpResult = spawnSync(launcherPath, ['help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  if (helpResult.status !== 0 || !helpResult.stdout.includes('hop - HopIt local workspace agent')) {
    throw new Error(`Packaged hop help verification failed: ${helpResult.stderr || helpResult.stdout}`)
  }

  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hop-package-smoke-'))
  const statusResult = spawnSync(
    launcherPath,
    [
      'status',
      '--profile',
      'production',
      '--codebase-id',
      'package-smoke',
      '--state-root',
      path.join(smokeRoot, 'state'),
      '--workspace-root',
      path.join(smokeRoot, 'workspaces'),
      '--allow-local-cloud',
    ],
    {
      cwd: smokeRoot,
      encoding: 'utf8',
    },
  )

  if (
    statusResult.status !== 0 ||
    !statusResult.stdout.includes('"readiness": "not_initialized"') ||
    !statusResult.stdout.includes('"ok": false')
  ) {
    throw new Error(`Packaged hop status verification failed: ${statusResult.stderr || statusResult.stdout}`)
  }
}

async function createArchive() {
  await fs.rm(archivePath, { force: true })
  const result = spawnSync('tar', ['-czf', archivePath, '-C', artifactsRoot, packageName], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(`Failed to create ${archivePath}: ${result.stderr || result.stdout}`)
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}
