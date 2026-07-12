#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const nodeVersion = process.env.HOP_PACKAGE_NODE_VERSION ?? process.version
const artifactsRoot = path.join(repoRoot, 'artifacts')
const cacheRoot = path.join(artifactsRoot, 'cache')

// platform-arch -> node platform/arch (identical strings for the supported set,
// but kept explicit so the mapping is a single source of truth).
const TARGET_TABLE = {
  'darwin-arm64': { nodePlatform: 'darwin', nodeArch: 'arm64' },
  'darwin-x64': { nodePlatform: 'darwin', nodeArch: 'x64' },
  'linux-arm64': { nodePlatform: 'linux', nodeArch: 'arm64' },
  'linux-x64': { nodePlatform: 'linux', nodeArch: 'x64' },
}

export const VALID_TARGET_KEYS = Object.keys(TARGET_TABLE)

export function hostTargetKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  return Object.prototype.hasOwnProperty.call(TARGET_TABLE, key) ? key : null
}

function makeTarget(key) {
  const base = TARGET_TABLE[key]
  if (!base) {
    throw new Error(
      `Unsupported packaging target: ${key}. Valid targets: ${VALID_TARGET_KEYS.join(', ')}, all.`,
    )
  }
  return {
    key,
    platform: base.nodePlatform,
    arch: base.nodeArch,
    nodePlatform: base.nodePlatform,
    nodeArch: base.nodeArch,
    exeName: 'node',
    launcherName: 'hop',
  }
}

/**
 * Resolve the requested packaging targets from CLI args and/or env.
 * Precedence: explicit --target / HOP_PACKAGE_TARGET tokens (comma-separated,
 * repeatable) win; "all" expands to every valid target; empty falls back to the
 * host target. Invalid target keys throw. Returns a deduped array of target
 * descriptors preserving first-seen order.
 */
export function parseTargets({ argv = [], env = {}, host = hostTargetKey() } = {}) {
  const raw = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--target' || arg === '-t') {
      raw.push(argv[i + 1])
      i += 1
    } else if (typeof arg === 'string' && arg.startsWith('--target=')) {
      raw.push(arg.slice('--target='.length))
    }
  }
  if (env.HOP_PACKAGE_TARGET) raw.push(env.HOP_PACKAGE_TARGET)

  const tokens = raw
    .filter((value) => typeof value === 'string' && value.length > 0)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)

  let keys
  if (tokens.length === 0) {
    if (!host) {
      throw new Error(
        `No --target/HOP_PACKAGE_TARGET provided and host ${process.platform}-${process.arch} is not a supported packaging target. Valid targets: ${VALID_TARGET_KEYS.join(', ')}, all.`,
      )
    }
    keys = [host]
  } else if (tokens.includes('all')) {
    keys = [...VALID_TARGET_KEYS]
  } else {
    keys = tokens
  }

  const seen = new Set()
  const targets = []
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(makeTarget(key))
  }
  return targets
}

function targetContext(target) {
  const packageName = `hop-${target.nodePlatform}-${target.nodeArch}`
  const releaseRoot = path.join(artifactsRoot, packageName)
  const appRoot = path.join(releaseRoot, 'app')
  return {
    target,
    packageName,
    releaseRoot,
    runtimeRoot: path.join(releaseRoot, 'runtime'),
    appRoot,
    fixtureRoot: path.join(appRoot, 'fixtures'),
    binRoot: path.join(releaseRoot, 'bin'),
    examplesRoot: path.join(releaseRoot, 'examples'),
    supportRoot: path.join(releaseRoot, 'support'),
    archivePath: path.join(artifactsRoot, `${packageName}.tar.gz`),
    checksumPath: path.join(artifactsRoot, `${packageName}.tar.gz.sha256`),
    bundledCliPath: path.join(appRoot, 'hop.mjs'),
    runtimeNodePath: path.join(releaseRoot, 'runtime', target.exeName),
  }
}

/**
 * Build one packaged target end to end and return a summary record. This is the
 * single-target worker that both the CLI and the release script drive.
 */
export async function buildTarget(target) {
  const ctx = targetContext(target)

  await fs.rm(ctx.releaseRoot, { recursive: true, force: true })
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.mkdir(ctx.runtimeRoot, { recursive: true })
  await fs.mkdir(ctx.fixtureRoot, { recursive: true })
  await fs.mkdir(ctx.binRoot, { recursive: true })
  await fs.mkdir(ctx.examplesRoot, { recursive: true })
  await fs.mkdir(ctx.supportRoot, { recursive: true })

  const officialNodePath = await ensureOfficialNodeRuntime(target)
  await copyExecutable(officialNodePath, ctx.runtimeNodePath)

  await build({
    entryPoints: [path.join(repoRoot, 'packages/agent/src/cli.js')],
    outfile: ctx.bundledCliPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    legalComments: 'none',
  })
  await fs.chmod(ctx.bundledCliPath, 0o755)

  await fs.copyFile(
    path.join(repoRoot, 'packages/agent/fixtures/demo-cloud.json'),
    path.join(ctx.fixtureRoot, 'demo-cloud.json'),
  )
  await writeLauncher(ctx)
  await writeSupportFiles(ctx)
  await writeReadme(ctx)
  await writeManifest(ctx)
  const verified = await verifyRelease(ctx)
  await createArchive(ctx)
  const sha256 = await sha256File(ctx.archivePath)
  await fs.writeFile(ctx.checksumPath, `${sha256}  ${ctx.packageName}.tar.gz\n`, 'utf8')

  return {
    target: target.key,
    packageName: ctx.packageName,
    releaseRoot: ctx.releaseRoot,
    archivePath: ctx.archivePath,
    checksumPath: ctx.checksumPath,
    sha256,
    verified,
    nodeVersion,
  }
}

/**
 * Build every requested target in sequence within a single invocation.
 */
export async function packageTargets(targets) {
  const results = []
  for (const target of targets) {
    results.push(await buildTarget(target))
  }
  return results
}

async function main() {
  const targets = parseTargets({ argv: process.argv.slice(2), env: process.env })
  const results = await packageTargets(targets)
  console.log(JSON.stringify({ ok: true, targets: results }, null, 2))
}

async function ensureOfficialNodeRuntime(target) {
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

async function writeLauncher(ctx) {
  await fs.writeFile(
    path.join(ctx.binRoot, ctx.target.launcherName),
    `#!/bin/sh
set -eu
SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SELF_DIR/../runtime/node" "$SELF_DIR/../app/hop.mjs" "$@"
`,
    'utf8',
  )
  await fs.chmod(path.join(ctx.binRoot, ctx.target.launcherName), 0o755)
}

async function writeReadme(ctx) {
  await fs.writeFile(
    path.join(ctx.releaseRoot, 'README.txt'),
    `HopIt standalone command

Install:
  cp examples/production.env.example ~/.config/hopit/production.env
  edit ~/.config/hopit/production.env
  ./bin/hop service start --profile production

Start on login:
  macOS: ./support/install-macos-launch-agent.sh
  Linux: ./support/install-systemd-user-service.sh
  macOS installer copies the package to ~/Library/Application Support/HopIt/Runtime before registering launchd.

Run:
  ./bin/hop help
  ./bin/hop import --profile production --source /path/to/project --codebase-id my-project --force
  ./bin/hop import-git-url --profile production --url https://github.com/org/repo.git --codebase-id my-project
  ./bin/hop workspace ensure --profile production --codebase-id my-project
  ./bin/hop service start --profile production --codebase-id my-project
  ./bin/hop service status --profile production --codebase-id my-project
  ./bin/hop backup --profile production --codebase-id my-project --output /path/to/agent-backup
  ./bin/hop export --profile production --output /path/to/export
  ./bin/hop export --profile production --include-private --output /path/to/private-backup
  ./bin/hop publish --profile production --output /path/to/publish
  ./bin/hop session revoke --profile production --session-id old-session-id
  ./bin/hop session register --profile production --device-name "$(hostname)"

Observe:
  ./bin/hop status --profile production
  ./bin/hop service status --profile production
  curl http://127.0.0.1:4785/status
  curl http://127.0.0.1:4785/events

This package includes its own Node runtime, so Node and npm are not required on
the target machine. The support scripts install a user-level service only after
you create the local env file. It is not signed or notarized yet.
`,
    'utf8',
  )
}

async function writeSupportFiles(ctx) {
  const envDefaults = packageEnvDefaults(ctx.target)

  await fs.writeFile(
    path.join(ctx.examplesRoot, 'production.env.example'),
    `HOPIT_CODEBASE_ID=hopit
HOPIT_CLOUD_BACKEND=d1
HOPIT_D1_ACCOUNT_ID=replace-with-cloudflare-account-id
HOPIT_D1_DATABASE_ID=replace-with-cloudflare-d1-database-id
HOPIT_D1_API_TOKEN=replace-with-cloudflare-d1-api-token-or-hopit-d1-proxy-token
HOPIT_D1_API_BASE_URL=https://hopit-d1-api.<account-subdomain>.workers.dev
HOPIT_D1_ASSUME_SCHEMA=1
HOPIT_AUTH_PROVIDER=clerk
# Emergency recovery only. Leave commented out for normal Clerk/D1 production access.
# HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1
# HOPIT_DASHBOARD_USERNAME=hopit
# HOPIT_DASHBOARD_PASSWORD=replace-with-a-long-random-dashboard-password
# Clerk production auth for hopit.dev.
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_replace-with-your-clerk-publishable-key
CLERK_SECRET_KEY=sk_live_replace-with-your-clerk-secret-key
CLERK_JWT_ISSUER_DOMAIN=https://clerk.hopit.dev
HOPIT_OWNER_EMAIL=you@example.com
HOPIT_AGENT_STATE_ROOT="${envDefaults.stateRoot}"
HOPIT_WORKSPACE_ROOT="${envDefaults.workspaceRoot}"
HOPIT_WORKSPACE_INDEX="${envDefaults.workspaceIndex}"
HOPIT_SESSION_ID=replace-with-this-device-session-id
HOPIT_DEVICE_NAME="Your Mac"
HOPIT_AGENT_SESSION_TOKEN=replace-after-hop-session-register
HOPIT_AGENT_SESSION_CAPABILITIES=read,write,sync,watch
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_PULL_COOLDOWN_MS=300000
HOPIT_BACKUP_ROOT=$HOME/HopIt-Backups
HOPIT_EXPORT_ROOT=$HOME/HopIt-Exports
HOPIT_BLOB_PROVIDER=r2
HOPIT_BLOB_PREFIX=production
HOPIT_BLOB_FREE_ONLY=1
HOPIT_BLOB_STORAGE_BUDGET_BYTES=8000000000
HOPIT_R2_ACCOUNT_ID=replace-with-cloudflare-account-id
HOPIT_R2_BUCKET=hopit-blobs
HOPIT_R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
HOPIT_R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
# Local-only secret-sync bridge. Prefer \`hop keys init-device\` for new devices;
# it can derive this in memory from the local user-vault keyring.
HOPIT_CLIENT_ENCRYPTION_KEY=base64:replace-with-32-random-bytes
HOPIT_CLIENT_ENCRYPTION_SCOPE=secrets
# Optional override. Default: $HOPIT_AGENT_STATE_ROOT/keys/<codebaseId>.device.json
# HOPIT_DEVICE_KEYS_PATH=$HOME/.config/hopit/keys/hopit.device.json
# One-shot recovery export only; do not leave this passphrase in persistent env.
# HOPIT_RECOVERY_PASSPHRASE=replace-only-when-running-hop-keys-export-recovery

# Backblaze B2 migration path:
# HOPIT_BLOB_PROVIDER=b2
# HOPIT_B2_BUCKET=hopit-blobs
# HOPIT_B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
# HOPIT_B2_REGION=us-west-004
# HOPIT_B2_KEY_ID=replace-with-b2-key-id
# HOPIT_B2_APPLICATION_KEY=replace-with-b2-application-key

`,
    'utf8',
  )

  await writeExecutableSupportFile(
    ctx,
    'install-macos-launch-agent.sh',
    `#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS launchd." >&2
  exit 1
fi

SOURCE_PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
INSTALL_ROOT="$HOME/Library/Application Support/HopIt/Runtime"
if [ -n "\${HOPIT_INSTALL_ROOT-}" ]; then
  INSTALL_ROOT="$HOPIT_INSTALL_ROOT"
fi
PACKAGE_ROOT="$INSTALL_ROOT/$(basename "$SOURCE_PACKAGE_ROOT")"
ENV_FILE="$HOME/.config/hopit/production.env"
if [ -n "\${HOPIT_ENV_FILE-}" ]; then
  ENV_FILE="$HOPIT_ENV_FILE"
fi
LABEL="com.hopit.agent"
if [ -n "\${HOPIT_LAUNCHD_LABEL-}" ]; then
  LABEL="$HOPIT_LAUNCHD_LABEL"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/HopIt"

mkdir -p "$(dirname "$ENV_FILE")" "$(dirname "$PLIST")" "$LOG_DIR" "$INSTALL_ROOT"
if [ "$SOURCE_PACKAGE_ROOT" != "$PACKAGE_ROOT" ]; then
  rm -rf "$PACKAGE_ROOT"
  cp -R "$SOURCE_PACKAGE_ROOT" "$PACKAGE_ROOT"
fi
xattr -cr "$PACKAGE_ROOT" >/dev/null 2>&1 || true
chmod +x "$PACKAGE_ROOT/bin/hop" "$PACKAGE_ROOT/runtime/node" "$PACKAGE_ROOT/support"/*.sh

if [ ! -f "$ENV_FILE" ]; then
  cp "$PACKAGE_ROOT/examples/production.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Run '$PACKAGE_ROOT/bin/hop setup' for guided first-run configuration, or edit it with real HopIt values, then rerun this installer." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g'
}

COMMAND="set -a; . \\"$ENV_FILE\\"; set +a; exec \\"$PACKAGE_ROOT/bin/hop\\" service run --profile production"
ESCAPED_COMMAND="$(xml_escape "$COMMAND")"
ESCAPED_HOME="$(xml_escape "$HOME")"
ESCAPED_STDOUT="$(xml_escape "$LOG_DIR/agent.out.log")"
ESCAPED_STDERR="$(xml_escape "$LOG_DIR/agent.err.log")"

{
  printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\\n' '<plist version="1.0">'
  printf '%s\\n' '<dict>'
  printf '%s\\n' '  <key>Label</key>'
  printf '  <string>%s</string>\\n' "$LABEL"
  printf '%s\\n' '  <key>ProgramArguments</key>'
  printf '%s\\n' '  <array>'
  printf '%s\\n' '    <string>/bin/sh</string>'
  printf '%s\\n' '    <string>-lc</string>'
  printf '    <string>%s</string>\\n' "$ESCAPED_COMMAND"
  printf '%s\\n' '  </array>'
  printf '%s\\n' '  <key>RunAtLoad</key>'
  printf '%s\\n' '  <true/>'
  printf '%s\\n' '  <key>KeepAlive</key>'
  printf '%s\\n' '  <true/>'
  printf '%s\\n' '  <key>WorkingDirectory</key>'
  printf '  <string>%s</string>\\n' "$ESCAPED_HOME"
  printf '%s\\n' '  <key>StandardOutPath</key>'
  printf '  <string>%s</string>\\n' "$ESCAPED_STDOUT"
  printf '%s\\n' '  <key>StandardErrorPath</key>'
  printf '  <string>%s</string>\\n' "$ESCAPED_STDERR"
  printf '%s\\n' '</dict>'
  printf '%s\\n' '</plist>'
} > "$PLIST"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
launchctl start "$LABEL" >/dev/null 2>&1 || true

# --- Global hop launcher ---------------------------------------------------
# The packaged launcher resolves its sibling runtime/app relative to its own
# directory via "\$0", so install a tiny wrapper that execs the real launcher
# by absolute path instead of a bare symlink. Regenerated on every install so
# it survives runtime reinstalls; PACKAGE_ROOT is stable across reinstalls.
if [ -w /usr/local/bin ]; then
  BIN_DIR=/usr/local/bin
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
HOP_LINK="$BIN_DIR/hop"
HOP_STAGE="$BIN_DIR/.hop.new.$$"
cat > "$HOP_STAGE" <<EOF
#!/bin/sh
exec "$PACKAGE_ROOT/bin/hop" "\\$@"
EOF
chmod +x "$HOP_STAGE"
mv -f "$HOP_STAGE" "$HOP_LINK"
echo "Global command: $HOP_LINK -> $PACKAGE_ROOT/bin/hop"
case ":\${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "$BIN_DIR is not on your PATH. Add it with:" >&2
    echo "  export PATH=\\"$BIN_DIR:\\$PATH\\"" >&2
    ;;
esac

echo "Installed HopIt launch agent: $PLIST"
echo "Logs: $LOG_DIR/agent.out.log and $LOG_DIR/agent.err.log"
`,
  )

  await writeExecutableSupportFile(
    ctx,
    'uninstall-macos-launch-agent.sh',
    `#!/bin/sh
set -eu

LABEL="com.hopit.agent"
if [ -n "\${HOPIT_LAUNCHD_LABEL-}" ]; then
  LABEL="$HOPIT_LAUNCHD_LABEL"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "Removed HopIt launch agent: $PLIST"
`,
  )

  await writeExecutableSupportFile(
    ctx,
    'install-systemd-user-service.sh',
    `#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "This installer is for Linux systemd user services." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required for this installer." >&2
  exit 1
fi

PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$HOME/.config/hopit/production.env"
if [ -n "\${HOPIT_ENV_FILE-}" ]; then
  ENV_FILE="$HOPIT_ENV_FILE"
fi
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/hopit-agent.service"
RUNNER="$HOME/.config/hopit/run-agent.sh"

mkdir -p "$(dirname "$ENV_FILE")" "$SERVICE_DIR" "$(dirname "$RUNNER")"
if [ ! -f "$ENV_FILE" ]; then
  cp "$PACKAGE_ROOT/examples/production.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Run '$PACKAGE_ROOT/bin/hop setup' for guided first-run configuration, or edit it with real HopIt values, then rerun this installer." >&2
  exit 1
fi

{
  printf '%s\\n' '#!/bin/sh'
  printf '%s\\n' 'set -eu'
  printf '%s\\n' 'set -a'
  printf '. "%s"\\n' "$ENV_FILE"
  printf '%s\\n' 'set +a'
  printf 'exec "%s/bin/hop" service run --profile production\\n' "$PACKAGE_ROOT"
} > "$RUNNER"
chmod 700 "$RUNNER"

{
  printf '%s\\n' '[Unit]'
  printf '%s\\n' 'Description=HopIt local workspace agent'
  printf '%s\\n' 'After=network-online.target'
  printf '%s\\n' ''
  printf '%s\\n' '[Service]'
  printf '%s\\n' 'Type=simple'
  printf 'ExecStart=%s\\n' "$RUNNER"
  printf '%s\\n' 'Restart=on-failure'
  printf '%s\\n' 'RestartSec=5'
  printf 'WorkingDirectory=%s\\n' "$HOME"
  printf '%s\\n' ''
  printf '%s\\n' '[Install]'
  printf '%s\\n' 'WantedBy=default.target'
} > "$SERVICE_FILE"

systemctl --user daemon-reload
systemctl --user enable --now hopit-agent.service

# --- Global hop launcher ---------------------------------------------------
# The packaged launcher resolves its sibling runtime/app relative to its own
# directory via "\$0", so install a tiny wrapper that execs the real launcher
# by absolute path instead of a bare symlink. Regenerated on every install so
# it survives runtime reinstalls; PACKAGE_ROOT is stable across reinstalls.
if [ -w /usr/local/bin ]; then
  BIN_DIR=/usr/local/bin
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
HOP_LINK="$BIN_DIR/hop"
HOP_STAGE="$BIN_DIR/.hop.new.$$"
cat > "$HOP_STAGE" <<EOF
#!/bin/sh
exec "$PACKAGE_ROOT/bin/hop" "\\$@"
EOF
chmod +x "$HOP_STAGE"
mv -f "$HOP_STAGE" "$HOP_LINK"
echo "Global command: $HOP_LINK -> $PACKAGE_ROOT/bin/hop"
case ":\${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "$BIN_DIR is not on your PATH. Add it with:" >&2
    echo "  export PATH=\\"$BIN_DIR:\\$PATH\\"" >&2
    ;;
esac

echo "Installed HopIt systemd user service: $SERVICE_FILE"
echo "Status: systemctl --user status hopit-agent.service"
`,
  )

  await writeExecutableSupportFile(
    ctx,
    'uninstall-systemd-user-service.sh',
    `#!/bin/sh
set -eu

SERVICE_FILE="$HOME/.config/systemd/user/hopit-agent.service"
RUNNER="$HOME/.config/hopit/run-agent.sh"
systemctl --user disable --now hopit-agent.service >/dev/null 2>&1 || true
rm -f "$SERVICE_FILE"
rm -f "$RUNNER"
systemctl --user daemon-reload >/dev/null 2>&1 || true
echo "Removed HopIt systemd user service: $SERVICE_FILE"
`,
  )
}

function packageEnvDefaults(target) {
  if (target.platform === 'linux') {
    const stateRoot = '${XDG_STATE_HOME:-$HOME/.local/state}/hopit/agent'
    return {
      stateRoot,
      workspaceRoot: '$HOME/HopIt Workspaces',
      workspaceIndex: `${stateRoot}/workspaces.json`,
    }
  }

  return {
    stateRoot: '$HOME/Library/Application Support/HopIt/Agent',
    workspaceRoot: '$HOME/HopIt Workspaces',
    workspaceIndex: '$HOME/Library/Application Support/HopIt/Agent/workspaces.json',
  }
}

async function writeExecutableSupportFile(ctx, name, content) {
  const filePath = path.join(ctx.supportRoot, name)
  await fs.writeFile(filePath, content, 'utf8')
  await fs.chmod(filePath, 0o755)
}

async function writeManifest(ctx) {
  const manifest = {
    name: 'hop',
    version: readPackageJson().version,
    nodeVersion,
    target: ctx.target,
    createdAt: new Date().toISOString(),
    files: {
      launcher: `bin/${ctx.target.launcherName}`,
      runtime: `runtime/${ctx.target.exeName}`,
      app: 'app/hop.mjs',
      fixture: 'app/fixtures/demo-cloud.json',
      productionEnvExample: 'examples/production.env.example',
      macosLaunchAgentInstaller: 'support/install-macos-launch-agent.sh',
      macosLaunchAgentUninstaller: 'support/uninstall-macos-launch-agent.sh',
      systemdUserServiceInstaller: 'support/install-systemd-user-service.sh',
      systemdUserServiceUninstaller: 'support/uninstall-systemd-user-service.sh',
    },
    checksums: {
      app: await sha256File(ctx.bundledCliPath),
      runtime: await sha256File(ctx.runtimeNodePath),
    },
  }

  await fs.writeFile(path.join(ctx.releaseRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function readPackageJson() {
  return JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./package.json")))'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout)
}

/**
 * Verify a built release. For a target matching the host platform+arch this runs
 * the packaged launcher (`hop help` + a status smoke run). For cross targets the
 * launcher cannot execute here, so verify structurally: launcher present and
 * executable, runtime node binary present, and the bundled hop.mjs parses under
 * the host Node (`node --check`, valid because it is plain JS). Returns whether
 * verification succeeded (throws on failure).
 */
async function verifyRelease(ctx) {
  const isHostTarget = ctx.target.platform === process.platform && ctx.target.arch === process.arch
  if (isHostTarget) {
    return verifyHostRelease(ctx)
  }
  return verifyCrossRelease(ctx)
}

async function verifyHostRelease(ctx) {
  const launcherPath = path.join(ctx.binRoot, ctx.target.launcherName)
  // The packaged CLI autoloads ~/.config/hopit/production.env; these smoke
  // checks must stay hermetic on machines with a live config, so opt out.
  const smokeEnv = { ...process.env, HOPIT_NO_ENV_FILE: '1' }
  const helpResult = spawnSync(launcherPath, ['help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: smokeEnv,
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
      env: smokeEnv,
    },
  )

  if (
    statusResult.status !== 0 ||
    !statusResult.stdout.includes('"readiness": "not_initialized"') ||
    !statusResult.stdout.includes('"ok": false')
  ) {
    throw new Error(`Packaged hop status verification failed: ${statusResult.stderr || statusResult.stdout}`)
  }

  return true
}

async function verifyCrossRelease(ctx) {
  const launcherPath = path.join(ctx.binRoot, ctx.target.launcherName)
  if (!(await isExecutable(launcherPath))) {
    throw new Error(`Cross-target verify failed: launcher missing or not executable at ${launcherPath}`)
  }
  if (!(await isExecutable(ctx.runtimeNodePath))) {
    throw new Error(`Cross-target verify failed: runtime node missing or not executable at ${ctx.runtimeNodePath}`)
  }
  const stat = await fs.stat(ctx.bundledCliPath)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Cross-target verify failed: bundled app missing at ${ctx.bundledCliPath}`)
  }
  const checkResult = spawnSync(process.execPath, ['--check', ctx.bundledCliPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (checkResult.status !== 0) {
    throw new Error(`Cross-target verify failed: bundled app did not parse: ${checkResult.stderr || checkResult.stdout}`)
  }
  return true
}

async function createArchive(ctx) {
  await fs.rm(ctx.archivePath, { force: true })
  const result = spawnSync('tar', ['-czf', ctx.archivePath, '-C', artifactsRoot, ctx.packageName], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(`Failed to create ${ctx.archivePath}: ${result.stderr || result.stdout}`)
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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  await main()
}
