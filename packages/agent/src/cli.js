#!/usr/bin/env node
// @ts-check

import { applyLocalDeviceKeyring, runKeysCommand } from './commands/keys.js'
import { backupAgentState, exportGitSnapshot, runDoctor, validateCloud } from './commands/export.js'
import { compareCloudRevisions } from './commands/compare.js'
import { hydrateWorkspace } from './commands/hydrate.js'
import { importGitProject, importLocalProject, importRemoteGitProject, initCloud, mirrorLocalProject } from './commands/import.js'
import { installAgent } from './commands/install.js'
import { runSessionCommand } from './commands/keys.js'
import { mergeChangeSet, openChangeSetReview, recoverJournal, refreshWorkspace, syncOnce } from './commands/sync.js'
import { manageStorage } from './commands/storage.js'
import { runWorkspaceCommand } from './commands/workspace.js'
import { runDemo } from './commands/demo.js'
import { normalizeCommand, parseOptions } from './options.js'
import { printHelp } from './help.js'
import { readAgentState } from './status-state.js'
import { runServiceCommand, runServiceProcess, serveStatus } from './service.js'
import { remotePullOnce, watchWorkspace } from './watch.js'

async function main() {
  const [rawCommand = 'help', ...rawArgs] = process.argv.slice(2)
  const command = normalizeCommand(rawCommand)
  const args = [...rawArgs]
  const serviceAction =
    command === 'service' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const workspaceAction =
    command === 'workspace' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const sessionAction =
    command === 'session' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const keysAction =
    command === 'keys' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const parsedOptions = parseOptions(args)
  const options = command === 'keys' ? parsedOptions : await applyLocalDeviceKeyring(parsedOptions)

  if (command === 'init') return initCloud(options)
  if (command === 'import-local') return importLocalProject(options)
  if (command === 'mirror-local') return mirrorLocalProject(options)
  if (command === 'import-git') return importGitProject(options)
  if (command === 'import-git-url') return importRemoteGitProject(options)
  if (command === 'storage') return manageStorage(options, args)
  if (command === 'compare') return compareCloudRevisions(options)
  if (command === 'hydrate') return hydrateWorkspace(options)
  if (command === 'refresh') return refreshWorkspace(options)
  if (command === 'remote-pull') return remotePullOnce(options)
  if (command === 'sync-once') return syncOnce(options)
  if (command === 'recover') {
    const recovery = await recoverJournal(options)
    if (recovery.failed > 0) process.exitCode = 1
    return
  }
  if (command === 'review-open') return openChangeSetReview(options)
  if (command === 'merge') return mergeChangeSet(options)
  if (command === 'export-git') return exportGitSnapshot(options, { requireMerged: false })
  if (command === 'publish') return exportGitSnapshot(options, { requireMerged: true })
  if (command === 'validate') return validateCloud(options)
  if (command === 'doctor') return runDoctor(options)
  if (command === 'backup') return backupAgentState(options)
  if (command === 'install') return installAgent(options)
  if (command === 'workspace') return runWorkspaceCommand(workspaceAction, options)
  if (command === 'session') return runSessionCommand(sessionAction, options)
  if (command === 'keys') return runKeysCommand(keysAction, options)
  if (command === 'service') return runServiceCommand(serviceAction, options)
  if (command === 'service-run') return runServiceProcess(options)
  if (command === 'watch') return watchWorkspace(options)
  if (command === 'status') {
    const state = await readAgentState(options)
    console.log(JSON.stringify(state.status, null, 2))
    return
  }
  if (command === 'status-server') return serveStatus(options)
  if (command === 'demo') return runDemo(options)

  printHelp()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
