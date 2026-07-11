#!/usr/bin/env node
// @ts-check

import { applyLocalDeviceKeyring, runKeysCommand } from './commands/keys.js'
import { backupAgentState, exportGitSnapshot, runDoctor, validateCloud } from './commands/export.js'
import { compareCloudRevisions } from './commands/compare.js'
import { hydrateWorkspace } from './commands/hydrate.js'
import { importGitProject, importLocalProject, importRemoteGitProject, initCloud, mirrorLocalProject } from './commands/import.js'
import { installAgent } from './commands/install.js'
import { runSetup } from './commands/setup.js'
import { runAdd } from './commands/add.js'
import { applyConnectionStore } from './connections.js'
import { runSessionCommand } from './commands/keys.js'
import { mergeChangeSet, openChangeSetReview, recoverJournal, refreshWorkspace, syncOnce } from './commands/sync.js'
import { manageStorage } from './commands/storage.js'
import { runWorkspaceCommand } from './commands/workspace.js'
import { runDemo } from './commands/demo.js'
import { normalizeCommand, parseOptions } from './options.js'
import { autoloadEnvFile } from './env-file.js'
import { runInteractive } from './commands/interactive.js'
import { printHelp } from './help.js'
import { readAgentState } from './status-state.js'
import { runServiceCommand, runServiceProcess, serveStatus } from './service.js'
import { remotePullOnce, watchWorkspace } from './watch.js'

// One-shot, user-facing commands that render concise human progress by default.
// Daemons (watch, service run) and structured queries (status, serve, keys, …)
// stay on the raw event/JSON output that logs and machine consumers rely on.
const HUMAN_OUTPUT_COMMANDS = new Set([
  'add',
  'init',
  'import-local',
  'mirror-local',
  'import-git',
  'import-git-url',
  'hydrate',
  'refresh',
  'sync-once',
  'recover',
])

async function main() {
  // Auto-load ~/.config/hopit/production.env (or $HOPIT_ENV_FILE) before parsing
  // options so HOPIT_PROFILE=production and the other deployed settings take
  // effect without the user sourcing the file or passing --profile. Explicit
  // environment always wins; $HOPIT_NO_ENV_FILE=1 skips it.
  autoloadEnvFile()

  const argv = process.argv.slice(2)
  // Bare `hop` on an interactive terminal opens the menu; piped/non-TTY prints
  // help so scripts never hang. Explicit `hop help` still prints help.
  if (argv.length === 0) {
    return runInteractive()
  }

  const [rawCommand = 'help', ...rawArgs] = argv
  let command = normalizeCommand(rawCommand)
  const args = [...rawArgs]
  // `hop project add` is an alias for `hop add`.
  if (command === 'project') {
    const sub = args[0] && !args[0].startsWith('--') ? args.shift() : ''
    if (sub && sub !== 'add') throw new Error(`Unknown project subcommand: ${sub}. Try: hop project add`)
    command = 'add'
  }
  const serviceAction =
    command === 'service' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const workspaceAction =
    command === 'workspace' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const sessionAction =
    command === 'session' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const keysAction =
    command === 'keys' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const parsedOptions = parseOptions(args)
  const options =
    command === 'keys' || command === 'setup' || command === 'add'
      ? parsedOptions
      : await applyConnectionStore(await applyLocalDeviceKeyring(parsedOptions))
  if (HUMAN_OUTPUT_COMMANDS.has(command)) options._humanOutput = true

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
  if (command === 'setup') return runSetup(options)
  if (command === 'add') return runAdd(options)
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
