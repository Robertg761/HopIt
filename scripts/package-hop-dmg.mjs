#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { packageTargets, parseTargets } from './package-hop.mjs'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const artifactsRoot = path.join(repoRoot, 'artifacts')
const MAC_TARGETS = ['darwin-arm64', 'darwin-x64']

export async function buildMacDmg({ built, version = localVersion() }) {
  assertMacPackages(built)
  requireMacTool('hdiutil')

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-dmg-'))
  const volumeRoot = path.join(stagingRoot, 'HopIt')
  const payloadRoot = path.join(volumeRoot, '.payload')
  const dmgPath = path.join(artifactsRoot, 'HopIt-macOS.dmg')
  const checksumPath = `${dmgPath}.sha256`

  try {
    await fs.mkdir(payloadRoot, { recursive: true })
    for (const target of MAC_TARGETS) {
      const result = built.find((entry) => entry.target === target)
      await fs.cp(result.releaseRoot, path.join(payloadRoot, target), { recursive: true })
    }

    const installerPath = path.join(volumeRoot, 'Install HopIt.command')
    await fs.writeFile(installerPath, renderMacInstaller({ version }), 'utf8')
    await fs.chmod(installerPath, 0o755)
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
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

export function renderMacInstaller({ version }) {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
INSTALL_DIR="\${HOPIT_INSTALL_DIR:-$HOME/.hopit}"
BIN_DIR="\${HOPIT_BIN_DIR:-$HOME/.local/bin}"
VERSION="${version}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This HopIt installer requires macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64 | aarch64) TARGET="darwin-arm64" ;;
  x86_64 | amd64) TARGET="darwin-x64" ;;
  *)
    echo "This Mac processor is not supported by HopIt." >&2
    exit 1
    ;;
esac

PACKAGE_SRC="$SCRIPT_DIR/.payload/$TARGET"
[ -x "$PACKAGE_SRC/bin/hop" ] || {
  echo "The HopIt runtime for $TARGET is missing from this disk image." >&2
  exit 1
}

RUNTIMES_DIR="$INSTALL_DIR/runtimes"
RUNTIME_DIR="$RUNTIMES_DIR/$VERSION-$TARGET"
RUNTIME_STAGE="$RUNTIMES_DIR/.$VERSION-$TARGET.new.$$"
LAUNCHER="$BIN_DIR/hop"
LAUNCHER_STAGE="$BIN_DIR/.hop.new.$$"

cleanup() {
  [ ! -e "$RUNTIME_STAGE" ] || rm -rf "$RUNTIME_STAGE"
  [ ! -e "$LAUNCHER_STAGE" ] || rm -f "$LAUNCHER_STAGE"
}
trap cleanup EXIT HUP INT TERM

echo "Installing HopIt for $TARGET..."
mkdir -p "$RUNTIMES_DIR" "$BIN_DIR"

if [ ! -d "$RUNTIME_DIR" ]; then
  cp -R "$PACKAGE_SRC" "$RUNTIME_STAGE"
  xattr -cr "$RUNTIME_STAGE" >/dev/null 2>&1 || true
  chmod +x "$RUNTIME_STAGE/bin/hop" "$RUNTIME_STAGE/runtime/node" "$RUNTIME_STAGE/support"/*.sh
  HOPIT_NO_ENV_FILE=1 "$RUNTIME_STAGE/bin/hop" help >/dev/null
  mv "$RUNTIME_STAGE" "$RUNTIME_DIR"
fi

cat > "$LAUNCHER_STAGE" <<EOF
#!/bin/sh
exec "$RUNTIME_DIR/bin/hop" "\\$@"
EOF
chmod +x "$LAUNCHER_STAGE"
mv -f "$LAUNCHER_STAGE" "$LAUNCHER"

echo ""
echo "HopIt installed."
echo "Command: $LAUNCHER"

if [ "\${HOPIT_SKIP_SETUP:-0}" = "1" ]; then
  exit 0
fi

echo ""
echo "Starting device setup..."
exec "$LAUNCHER" setup
`
}

export function renderDmgReadme() {
  return `HopIt for macOS

1. Double-click "Install HopIt.command".
2. Follow the guided setup in Terminal.
3. Approve this Mac when HopIt opens your browser.

This disk image contains both Apple silicon and Intel runtimes. The installer
chooses the correct one on this Mac and installs only into your user account.
Administrator access is not required.

This build is not signed or notarized yet. If macOS blocks the first launch,
Control-click "Install HopIt.command", choose Open, then confirm Open.
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
    ? MAC_TARGETS.map((target) => ({ target, releaseRoot: path.join(artifactsRoot, `hop-${target}`) }))
    : await packageTargets(targets)
  const dmg = await buildMacDmg({ built })
  console.log(JSON.stringify({ ok: true, dmg }, null, 2))
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await main()
