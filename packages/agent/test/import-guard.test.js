import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { parseOptions } from '../src/options.js'
import { importLocalProject, mirrorLocalProject } from '../src/commands/import.js'
import { writeWorkspaceIndex } from '../src/workspace-index.js'

async function makeRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// Seed a workspace index that claims `workspace` belongs to `indexedCodebaseId`.
async function seedIndexForOtherCodebase(options, workspace, indexedCodebaseId) {
  await writeWorkspaceIndex(options, {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    codebases: [
      {
        id: indexedCodebaseId,
        name: indexedCodebaseId,
        workspace: { path: path.resolve(workspace) },
      },
    ],
  })
}

test('importLocalProject fails closed when the workspace is indexed for a different codebase', async () => {
  const root = await makeRoot('hopit-import-guard-')
  const source = path.join(root, 'source')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# import me\n', 'utf8')

  const stateRoot = path.join(root, 'state')
  const workspace = path.join(root, 'workspaces', 'shared')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, 'SENTINEL.md'), 'belongs to other\n', 'utf8')

  const options = parseOptions([
    '--source', source,
    '--codebase-id', 'mine',
    '--state-root', stateRoot,
    '--workspace', workspace,
    '--workspace-index', path.join(stateRoot, 'workspaces.json'),
    '--cloud', path.join(stateRoot, 'cloud', 'mine.json'),
    '--journal', path.join(stateRoot, 'journal', 'mine.ndjson'),
    '--events', path.join(stateRoot, 'events', 'mine.ndjson'),
    '--cloud-backend', 'local',
    '--allow-local-cloud',
    '--force',
  ])
  await seedIndexForOtherCodebase(options, workspace, 'other-codebase')

  await assert.rejects(
    () => importLocalProject(options),
    /already .*indexed for a different codebase "other-codebase"/s,
  )

  // The other codebase's workspace directory was not wiped.
  assert.equal(await fs.readFile(path.join(workspace, 'SENTINEL.md'), 'utf8'), 'belongs to other\n')
})

test('mirrorLocalProject fails closed before backup or wipe when the workspace is indexed for a different codebase', async () => {
  const root = await makeRoot('hopit-mirror-guard-')
  const source = path.join(root, 'source')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# mirror me\n', 'utf8')

  const stateRoot = path.join(root, 'state')
  const workspace = path.join(root, 'workspaces', 'shared')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(workspace, 'SENTINEL.md'), 'belongs to other\n', 'utf8')

  const options = parseOptions([
    '--source', source,
    '--codebase-id', 'mine',
    '--state-root', stateRoot,
    '--workspace', workspace,
    '--workspace-index', path.join(stateRoot, 'workspaces.json'),
    '--cloud', path.join(stateRoot, 'cloud', 'mine.json'),
    '--journal', path.join(stateRoot, 'journal', 'mine.ndjson'),
    '--events', path.join(stateRoot, 'events', 'mine.ndjson'),
    '--cloud-backend', 'local',
    '--allow-local-cloud',
    '--skip-service-control',
  ])
  await seedIndexForOtherCodebase(options, workspace, 'other-codebase')

  await assert.rejects(
    () => mirrorLocalProject(options),
    /already .*indexed for a different codebase "other-codebase"/s,
  )

  // No pre-wipe backup ran and the workspace is intact.
  assert.equal(await fs.readFile(path.join(workspace, 'SENTINEL.md'), 'utf8'), 'belongs to other\n')
  assert.equal(
    await fs.stat(path.join(stateRoot, 'backups')).then(() => true).catch(() => false),
    false,
  )
})
