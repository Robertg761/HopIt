import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { assertWorkspacePathSafe, detectNestedCloudSyncProvider } from '../src/paths.js'
import { migrateWorkspaceRoot } from '../src/commands/workspace-root.js'
import { parseOptions } from '../src/options.js'
import { runAdd } from '../src/commands/add.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// GR-H4: Workspace Roots nested inside consumer cloud-sync folders (Dropbox,
// iCloud Drive, OneDrive, Google Drive) must be refused, without a bypass.
// Decisions doc §12: "Nested cloud-sync is blocked."

test('detectNestedCloudSyncProvider recognizes well-known folder-name segments', async () => {
  const root = await makeRoot('hopit-cloud-sync-segment-')

  const dropbox = path.join(root, 'Dropbox', 'Projects', 'my-app')
  const dropboxBusiness = path.join(root, 'Dropbox (Business)', 'my-app')
  const icloud = path.join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'my-app')
  const oneDrive = path.join(root, 'OneDrive - Acme Corp', 'my-app')
  const googleDrive = path.join(root, 'Google Drive', 'My Drive', 'my-app')
  const safe = path.join(root, 'Projects', 'my-app')

  assert.equal(await detectNestedCloudSyncProvider(dropbox), 'Dropbox')
  assert.equal(await detectNestedCloudSyncProvider(dropboxBusiness), 'Dropbox')
  assert.equal(await detectNestedCloudSyncProvider(icloud), 'iCloud Drive')
  assert.equal(await detectNestedCloudSyncProvider(oneDrive), 'OneDrive')
  assert.equal(await detectNestedCloudSyncProvider(googleDrive), 'Google Drive')
  assert.equal(await detectNestedCloudSyncProvider(safe), null)

  // A folder that merely contains the word "dropbox" as a substring, not as its
  // own path segment, must not be flagged.
  const lookalike = path.join(root, 'MyDropboxNotes', 'my-app')
  assert.equal(await detectNestedCloudSyncProvider(lookalike), null)
})

test('detectNestedCloudSyncProvider recognizes marker files left by sync clients', async () => {
  const root = await makeRoot('hopit-cloud-sync-marker-')

  const dropboxRoot = path.join(root, 'anything', 'renamed-dropbox-folder')
  await fs.mkdir(dropboxRoot, { recursive: true })
  await fs.writeFile(path.join(dropboxRoot, '.dropbox.cache'), '', 'utf8')
  const nestedDropboxProject = path.join(dropboxRoot, 'nested', 'my-app')
  await fs.mkdir(nestedDropboxProject, { recursive: true })

  const oneDriveRoot = path.join(root, 'other', 'renamed-onedrive-folder')
  await fs.mkdir(oneDriveRoot, { recursive: true })
  await fs.writeFile(path.join(oneDriveRoot, '.849C9593-D756-4E56-8D6E-42412F2A707B'), '', 'utf8')
  const nestedOneDriveProject = path.join(oneDriveRoot, 'my-app')
  await fs.mkdir(nestedOneDriveProject, { recursive: true })

  const googleDriveRoot = path.join(root, 'gd', 'renamed-google-drive-folder')
  await fs.mkdir(googleDriveRoot, { recursive: true })
  await fs.writeFile(path.join(googleDriveRoot, '.googledrivefs'), '', 'utf8')
  const nestedGoogleDriveProject = path.join(googleDriveRoot, 'my-app')
  await fs.mkdir(nestedGoogleDriveProject, { recursive: true })

  const icloudRoot = path.join(root, 'ic', 'renamed-icloud-folder')
  await fs.mkdir(icloudRoot, { recursive: true })
  await fs.writeFile(path.join(icloudRoot, '.icloud'), '', 'utf8')
  const nestedICloudProject = path.join(icloudRoot, 'my-app')
  await fs.mkdir(nestedICloudProject, { recursive: true })

  assert.equal(await detectNestedCloudSyncProvider(nestedDropboxProject), 'Dropbox')
  assert.equal(await detectNestedCloudSyncProvider(nestedOneDriveProject), 'OneDrive')
  assert.equal(await detectNestedCloudSyncProvider(nestedGoogleDriveProject), 'Google Drive')
  assert.equal(await detectNestedCloudSyncProvider(nestedICloudProject), 'iCloud Drive')
})

test('assertWorkspacePathSafe refuses all four simulated cloud-sync providers with an explanatory message', async () => {
  const root = await makeRoot('hopit-cloud-sync-assert-')
  const cases = [
    { workspace: path.join(root, 'Dropbox', 'my-app'), provider: 'Dropbox' },
    { workspace: path.join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'my-app'), provider: 'iCloud Drive' },
    { workspace: path.join(root, 'OneDrive', 'my-app'), provider: 'OneDrive' },
    { workspace: path.join(root, 'Google Drive', 'my-app'), provider: 'Google Drive' },
  ]

  for (const { workspace, provider } of cases) {
    await assert.rejects(
      assertWorkspacePathSafe({ workspace }),
      (error) => {
        assert.match(error.message, new RegExp(provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.match(error.message, /unrecoverable/)
        return true
      },
      `expected refusal for ${provider}`,
    )
  }
})

test('assertWorkspacePathSafe has no bypass for nested cloud-sync (--allow-unsafe-workspace does not help)', async () => {
  const root = await makeRoot('hopit-cloud-sync-nobypass-')
  const workspace = path.join(root, 'Dropbox', 'my-app')

  await assert.rejects(
    assertWorkspacePathSafe({ workspace, 'allow-unsafe-workspace': true }),
    /Dropbox/,
  )
})

test('assertWorkspacePathSafe leaves normal, non-cloud-sync paths unaffected', async () => {
  const root = await makeRoot('hopit-cloud-sync-normal-')
  const workspace = path.join(root, 'Projects', 'my-app')
  await fs.mkdir(workspace, { recursive: true })

  await assert.doesNotReject(assertWorkspacePathSafe({ workspace }))
})

test('workspace migrate-root refuses a destination nested inside a simulated Dropbox folder', async () => {
  const root = await makeRoot('hopit-cloud-sync-migrate-')
  const oldRoot = path.join(root, 'Old Workspaces')
  const alpha = path.join(oldRoot, 'alpha')
  await fs.mkdir(path.join(alpha, 'src'), { recursive: true })
  await fs.writeFile(path.join(alpha, 'src', 'index.js'), 'export const alpha = true\n')

  const stateRoot = path.join(root, 'state')
  const indexPath = path.join(stateRoot, 'workspaces.json')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: null,
    root: { path: oldRoot, adapter: 'managed-folder' },
    codebases: [
      { id: 'alpha', name: 'Alpha', workspace: { root: oldRoot, path: alpha, exists: true } },
    ],
  }, null, 2)}\n`)

  const newRoot = path.join(root, 'Dropbox', 'New Workspaces')
  const options = {
    'state-root': stateRoot,
    'workspace-index': indexPath,
    'new-root': newRoot,
    projects: 'alpha',
  }

  await assert.rejects(migrateWorkspaceRoot(options), /Dropbox/)

  // Nothing moved.
  assert.equal(await fs.readFile(path.join(alpha, 'src', 'index.js'), 'utf8'), 'export const alpha = true\n')
})

test('hop add refuses a --workspace-root nested inside a simulated OneDrive folder', async () => {
  const root = await makeRoot('hopit-cloud-sync-add-')
  const source = path.join(root, 'source-project')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# demo\n', 'utf8')

  const stateRoot = path.join(root, 'state')
  const workspaceRoot = path.join(root, 'OneDrive', 'workspaces')
  const envFile = path.join(root, 'config', 'production.env')

  const base = parseOptions([
    '--source', source,
    '--codebase-name', 'Demo',
    '--state-root', stateRoot,
    '--workspace-root', workspaceRoot,
    '--env-path', envFile,
    '--cloud-backend', 'local',
    '--allow-local-cloud',
  ])

  let authorizeCalled = false
  await assert.rejects(runAdd(base, {
    authorize: async () => {
      authorizeCalled = true
      throw new Error('authorize should not be reached: the workspace path check must fail first')
    },
  }), /OneDrive/)
  assert.equal(authorizeCalled, false, 'the cloud-sync check must run before browser authorization')
})

test('hop setup refuses a --workspace-root nested inside a simulated Google Drive folder', async () => {
  const root = await makeRoot('hopit-cloud-sync-setup-')
  const stateRoot = path.join(root, 'state')
  const workspaceRoot = path.join(root, 'Google Drive', 'workspaces')
  const envFile = path.join(root, 'config', 'production.env')

  try {
    await execFileAsync(process.execPath, [
      cliPath, 'setup',
      '--yes',
      '--workspace-root', workspaceRoot,
      '--state-root', stateRoot,
      '--env-path', envFile,
      '--codebase-id', 'gdrive-demo',
    ], { cwd: repoRoot, encoding: 'utf8' })
    assert.fail('expected hop setup to refuse a Google Drive-nested workspace root')
  } catch (error) {
    assert.match(String(error.stderr ?? error.message), /Google Drive/)
    assert.match(String(error.stderr ?? error.message), /unrecoverable/)
  }

  // Nothing was created.
  await assert.rejects(fs.stat(stateRoot))
})
