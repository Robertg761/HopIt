// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { defaultOptions, fileScope } from '../constants.js'
import { emit } from '../io.js'
import { cloudFileTextForVerification, countCloudScopes } from '../journal.js'
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
    force: true,
  }

  await initCloud(demoOptions)
  await hydrateWorkspace(demoOptions)

  const readmePath = path.join(demoOptions.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nEdited through the HopIt managed workspace folder.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: 'README.md', scope: scopeForPath('README.md') })

  const privatePath = '.private/agent-note.md'
  const privateAbsolutePath = path.join(demoOptions.workspace, privatePath)
  await fs.appendFile(privateAbsolutePath, '\nOwner-only demo snapshot.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: privatePath, scope: scopeForPath(privatePath) })

  await syncOnce(demoOptions)

  const demoCloudService = createCloudGraphService(demoOptions)
  const cloud = await demoCloudService.readGraph()
  const readmeContent = await cloudFileTextForVerification(cloud.files['README.md'], demoCloudService)
  const privateContent = await cloudFileTextForVerification(cloud.files[privatePath], demoCloudService)
  const saved = readmeContent.includes('managed workspace folder')
  const privateSaved =
    cloud.files[privatePath]?.scope === fileScope.ownerPrivate &&
    privateContent.includes('Owner-only demo snapshot.')

  await emit(demoOptions, 'demo.verified', {
    cloud: demoOptions.cloud,
    workspace: demoOptions.workspace,
    journal: demoOptions.journal,
    saved,
    privateSaved,
    scopeCounts: countCloudScopes(cloud),
  })

  if (!saved || !privateSaved) {
    throw new Error('Demo verification failed: cloud did not receive the shared and private edits.')
  }
}

