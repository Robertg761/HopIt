// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { defaultOptions, fileScope } from '../constants.js'
import { emit } from '../io.js'
import { cloudFileTextForVerification, countCloudScopes, hashContent } from '../journal.js'
import { hydrateWorkspace } from './hydrate.js'
import { initCloud } from './import.js'
import { syncOnce } from './sync.js'
import { scopeForPath } from '@hopit/core/privacy-zone'

export async function runDemo(options) {
  const demoOptions = {
    ...options,
    cloud: options.cloud === defaultOptions.cloud ? '.hopit-agent/demo/cloud.json' : options.cloud,
    workspace:
      options.workspace === defaultOptions.workspace
        ? '.hopit-agent/demo/workspaces/hopit-core'
        : options.workspace,
    journal: options.journal === defaultOptions.journal ? '.hopit-agent/demo/journal.ndjson' : options.journal,
    events: options.events === defaultOptions.events ? '.hopit-agent/demo/events.ndjson' : options.events,
    'blob-provider': options['blob-provider'] ?? process.env.HOPIT_BLOB_PROVIDER ?? 'filesystem',
    'blob-root': options['blob-root'] ?? process.env.HOPIT_BLOB_ROOT ?? '.hopit-agent/demo/blobs',
    force: true,
  }

  await fs.rm(demoOptions.workspace, { recursive: true, force: true })
  await fs.rm(demoOptions.cloud, { force: true })
  await fs.rm(demoOptions.journal, { force: true })
  await fs.rm(demoOptions.events, { force: true })
  await fs.rm(demoOptions['blob-root'], { recursive: true, force: true })

  await initCloud(demoOptions)
  await hydrateWorkspace(demoOptions)

  const readmePath = path.join(demoOptions.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nEdited through the HopIt managed workspace folder.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: 'README.md', scope: scopeForPath('README.md') })
  await syncOnce(demoOptions)

  const privatePath = '.private/agent-note.md'
  const demoCloudService = createCloudGraphService(demoOptions)
  const cloud = await demoCloudService.readGraph()
  const thirdRevision = 3
  const newSourcePath = 'src/demo-chain.ts'
  const newSourceContent = "export const demoRevision = 'three'\n"
  const privateContent = `${await cloudFileTextForVerification(cloud.files[privatePath], demoCloudService)}\nOwner-only demo snapshot.\n`
  cloud.revision = thirdRevision
  if (cloud.selectedState) cloud.selectedState.revision = thirdRevision
  cloud.files[newSourcePath] = {
    kind: 'file',
    content: newSourceContent,
    encoding: 'utf8',
    hash: hashContent(newSourceContent),
    size: Buffer.byteLength(newSourceContent),
    scope: scopeForPath(newSourcePath),
    privacyZone: 'repo-content',
    revision: thirdRevision,
    updatedAt: '2026-07-08T00:00:03.000Z',
  }
  cloud.files[privatePath] = {
    ...cloud.files[privatePath],
    content: privateContent,
    contentStorage: 'inline',
    blobProvider: null,
    blobKey: null,
    blobHash: null,
    blobSize: null,
    clientEncryption: null,
    hash: hashContent(privateContent),
    size: Buffer.byteLength(privateContent),
    revision: thirdRevision,
    updatedAt: '2026-07-08T00:00:03.000Z',
  }
  await demoCloudService.writeGraph(cloud, {
    now: '2026-07-08T00:00:03.000Z',
    actor: {
      actorUserId: cloud.owner?.id ?? cloud.codebase?.ownerId ?? null,
      sessionId: cloud.session?.id ?? null,
      deviceName: cloud.session?.deviceName ?? null,
    },
  })
  await emit(demoOptions, 'demo.graph_revision_created', {
    revision: thirdRevision,
    paths: [newSourcePath, privatePath],
  })

  const finalCloud = await demoCloudService.readGraph()
  const readmeContent = await cloudFileTextForVerification(finalCloud.files['README.md'], demoCloudService)
  const finalPrivateContent = await cloudFileTextForVerification(finalCloud.files[privatePath], demoCloudService)
  const compare = await demoCloudService.compareRevisions(1, 3, {
    requesterId: finalCloud.owner?.id ?? finalCloud.codebase?.ownerId,
    path: 'README.md',
  })
  const saved = readmeContent.includes('managed workspace folder')
  const privateSaved =
    finalCloud.files[privatePath]?.scope === fileScope.ownerPrivate &&
    finalPrivateContent.includes('Owner-only demo snapshot.')

  await emit(demoOptions, 'demo.verified', {
    cloud: demoOptions.cloud,
    workspace: demoOptions.workspace,
    journal: demoOptions.journal,
    saved,
    privateSaved,
    compare: compare.ok ? { summary: compare.summary, readmeDiff: compare.entries.find((entry) => entry.path === 'README.md')?.body?.diff ?? null } : compare,
    scopeCounts: countCloudScopes(finalCloud),
  })

  if (!saved || !privateSaved) {
    throw new Error('Demo verification failed: cloud did not receive the shared and private edits.')
  }

  console.log(JSON.stringify({
    ok: true,
    action: 'demo.compare',
    revisions: [1, 2, 3],
    summary: compare.summary,
    readmeDiff: compare.entries.find((entry) => entry.path === 'README.md')?.body?.diff ?? null,
  }, null, 2))
}
