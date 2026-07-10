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
const examplesRoot = path.join(releaseRoot, 'examples')
const supportRoot = path.join(releaseRoot, 'support')
const archivePath = path.join(artifactsRoot, `${packageName}.tar.gz`)
const bundledCliPath = path.join(appRoot, 'hop.mjs')
const runtimeNodePath = path.join(runtimeRoot, target.exeName)

await fs.rm(releaseRoot, { recursive: true, force: true })
await fs.mkdir(cacheRoot, { recursive: true })
await fs.mkdir(runtimeRoot, { recursive: true })
await fs.mkdir(fixtureRoot, { recursive: true })
await fs.mkdir(binRoot, { recursive: true })
await fs.mkdir(examplesRoot, { recursive: true })
await fs.mkdir(supportRoot, { recursive: true })

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
await writeSupportFiles()
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

async function writeSupportFiles() {
  const envDefaults = packageEnvDefaults()

  await fs.writeFile(
    path.join(examplesRoot, 'production.env.example'),
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

echo "Installed HopIt launch agent: $PLIST"
echo "Logs: $LOG_DIR/agent.out.log and $LOG_DIR/agent.err.log"
`,
  )

  await writeExecutableSupportFile(
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

echo "Installed HopIt systemd user service: $SERVICE_FILE"
echo "Status: systemctl --user status hopit-agent.service"
`,
  )

  await writeExecutableSupportFile(
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

function packageEnvDefaults() {
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

async function writeExecutableSupportFile(name, content) {
  const filePath = path.join(supportRoot, name)
  await fs.writeFile(filePath, content, 'utf8')
  await fs.chmod(filePath, 0o755)
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
      productionEnvExample: 'examples/production.env.example',
      macosLaunchAgentInstaller: 'support/install-macos-launch-agent.sh',
      macosLaunchAgentUninstaller: 'support/uninstall-macos-launch-agent.sh',
      systemdUserServiceInstaller: 'support/install-systemd-user-service.sh',
      systemdUserServiceUninstaller: 'support/uninstall-systemd-user-service.sh',
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
