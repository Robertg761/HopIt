// @ts-check
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseOptions } from '../options.js'
import { resolveEnvFilePath } from '../env-file.js'
import { readWorkspaceIndex } from '../workspace-index.js'
import { applyConnectionStore, listConnectionCodebaseIds } from '../connections.js'
import { applyLocalDeviceKeyring } from './keys.js'
import { runAdd } from './add.js'
import { runSetup } from './setup.js'
import { syncOnce, refreshWorkspace } from './sync.js'
import { runDoctor } from './export.js'
import { runServiceCommand, serviceStatus } from '../service.js'
import { printHelp } from '../help.js'
import { accent, bold, caution, muted, success, danger, writeLine } from '../output.js'

// ---------------------------------------------------------------------------
// Pure menu model (unit-tested). `state` is a plain snapshot of device state so
// which options appear — and how they are labeled — is a pure function of state.
// ---------------------------------------------------------------------------

/** @typedef {{ setUp: boolean, codebases: Array<{id:string,name?:string}>, serviceRunning: boolean, envFilePath: string|null }} InteractiveState */

// A device is "set up" once a production env file exists or at least one codebase
// has been connected (env file or a connection-store entry / workspace index row).
export function isSetUp(state) {
  return Boolean(state?.envFilePath) || (state?.codebases?.length ?? 0) > 0
}

/**
 * Build the menu shown for a device state. Returns a title/subtitle and the
 * ordered option list. Each option carries the equivalent CLI command string so
 * the UI can teach users the direct command they could have typed.
 * @param {InteractiveState} state
 */
export function buildMenuModel(state) {
  if (!isSetUp(state)) {
    return {
      title: 'Welcome to HopIt',
      subtitle: 'This device is not set up yet.',
      options: [
        { id: 'setup', label: 'Set up this device', command: 'hop setup' },
        { id: 'help', label: 'Show all commands', command: 'hop help' },
        { id: 'exit', label: 'Exit', command: null },
      ],
    }
  }

  const serviceOption = state.serviceRunning
    ? { id: 'service-stop', label: 'Stop background service', command: 'hop service stop' }
    : { id: 'service-start', label: 'Start background service', command: 'hop service start' }

  const count = state.codebases?.length ?? 0
  return {
    title: 'HopIt',
    subtitle: `${count} project${count === 1 ? '' : 's'} connected`,
    options: [
      { id: 'add', label: 'Add a project', command: 'hop add --source <folder>' },
      { id: 'status', label: 'Project status', command: 'hop status' },
      { id: 'sync', label: 'Sync now', command: 'hop sync' },
      { id: 'refresh', label: 'Refresh from cloud', command: 'hop refresh' },
      { id: 'doctor', label: 'Run health check', command: 'hop doctor' },
      serviceOption,
      { id: 'help', label: 'Show all commands', command: 'hop help' },
      { id: 'exit', label: 'Exit', command: null },
    ],
  }
}

export function menuOptionIds(state) {
  return buildMenuModel(state).options.map((option) => option.id)
}

// Map an option id to the name of the handler that runs it. Pure, so tests can
// assert every menu id dispatches somewhere and no id is orphaned.
export function handlerNameForId(id) {
  const map = {
    setup: 'runSetup',
    add: 'runAdd',
    status: 'showStatus',
    sync: 'syncOnce',
    refresh: 'refreshWorkspace',
    doctor: 'runDoctor',
    'service-start': 'serviceStart',
    'service-stop': 'serviceStop',
    help: 'printHelp',
    exit: 'exit',
  }
  return map[id] ?? null
}

// ---------------------------------------------------------------------------
// Impure: read device state, build runtime options, dispatch handlers.
// ---------------------------------------------------------------------------

export async function readInteractiveState() {
  const envFilePath = resolveEnvFilePath(process.env)
  let codebases = []
  try {
    const options = buildBaseOptions()
    const index = await readWorkspaceIndex(options)
    const indexed = (index?.codebases ?? []).map((entry) => ({ id: entry.id, name: entry.name }))
    const connectionIds = await listConnectionCodebaseIds(options)
    const byId = new Map(indexed.map((entry) => [entry.id, entry]))
    for (const id of connectionIds) if (!byId.has(id)) byId.set(id, { id, name: id })
    codebases = [...byId.values()]
  } catch {
    codebases = []
  }
  let serviceRunning = false
  try {
    const status = await serviceStatus(buildBaseOptions())
    serviceRunning = Boolean(status?.running)
  } catch {
    serviceRunning = false
  }
  return { envFilePath, codebases, serviceRunning, setUp: Boolean(envFilePath) }
}

function buildBaseOptions() {
  // The env file is already autoloaded by cli.js, so parseOptions([]) resolves
  // production paths (HOPIT_PROFILE / HOPIT_CODEBASE_ID / roots) from the env.
  const options = parseOptions([])
  options._humanOutput = true
  return options
}

async function buildDispatchOptions({ connectionStore = true } = {}) {
  let options = buildBaseOptions()
  if (connectionStore) {
    options = await applyConnectionStore(await applyLocalDeviceKeyring(options))
    options._humanOutput = true
  }
  return options
}

// Print the equivalent command line before running, so users graduate to the
// direct commands. Kept subtle (muted arrow) and always shown.
function announceCommand(command) {
  if (command) writeLine(`  ${muted('→')} ${accent(command)}`)
}

async function showStatus() {
  const options = await buildDispatchOptions()
  const index = await readWorkspaceIndex(options).catch(() => null)
  const codebases = index?.codebases ?? []
  const connectionIds = new Set(await listConnectionCodebaseIds(options).catch(() => []))
  writeLine()
  if (codebases.length === 0) {
    writeLine(`  ${caution('○')} No projects are connected yet. Choose “Add a project”.`)
    return
  }
  writeLine(`  ${bold('Projects')}`)
  for (const entry of codebases) {
    const connected = connectionIds.has(entry.id) || entry.id === options['codebase-id']
    const dot = connected ? success('●') : muted('○')
    const hydration = entry.hydration?.state ?? entry.materialization ?? 'unknown'
    writeLine(`  ${dot} ${bold(entry.id)} ${muted(`— ${entry.name ?? entry.id}`)}`)
    writeLine(`     ${muted('workspace')} ${entry.workspace?.path ?? 'n/a'}`)
    writeLine(`     ${muted('state')}     ${hydration}`)
  }
}

async function serviceControl(action) {
  const options = await buildDispatchOptions()
  await runServiceCommand(action, options)
  writeLine(`  ${success('✓')} Service ${action === 'start' ? 'started' : 'stopped'}.`)
}

async function promptFolderPath() {
  const answer = await promptLine(`  ${accent('?')} Folder to add ${muted('(absolute path)')}: `)
  const trimmed = (answer ?? '').trim()
  if (!trimmed) return null
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

async function runAddInteractive() {
  const source = await promptFolderPath()
  if (!source) {
    writeLine(`  ${caution('○')} No folder entered. Returning to menu.`)
    return
  }
  announceCommand(`hop add --source ${JSON.stringify(source)}`)
  const options = buildBaseOptions()
  options.source = source
  await runAdd(options)
}

// Dispatch table: id -> async handler. Each handler reuses the exact function the
// matching subcommand uses; the interactive layer never reimplements logic.
async function dispatch(id) {
  switch (id) {
    case 'setup':
      announceCommand('hop setup')
      return runSetup(buildBaseOptions())
    case 'add':
      return runAddInteractive()
    case 'status':
      announceCommand('hop status')
      return showStatus()
    case 'sync':
      announceCommand('hop sync')
      return syncOnce(await buildDispatchOptions())
    case 'refresh':
      announceCommand('hop refresh')
      return refreshWorkspace(await buildDispatchOptions())
    case 'doctor':
      announceCommand('hop doctor')
      return runDoctor(await buildDispatchOptions())
    case 'service-start':
      announceCommand('hop service start')
      return serviceControl('start')
    case 'service-stop':
      announceCommand('hop service stop')
      return serviceControl('stop')
    case 'help':
      announceCommand('hop help')
      printHelp()
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// TTY rendering + raw-mode keypress loop (isolated; not unit-tested).
// ---------------------------------------------------------------------------

function clearMenu(lineCount) {
  if (lineCount <= 0) return
  readline.moveCursor(process.stderr, 0, -lineCount)
  readline.clearScreenDown(process.stderr)
}

function renderMenu(model, selectedIndex) {
  const lines = []
  lines.push('')
  lines.push(`  ${accent('◆')} ${bold(model.title)}`)
  if (model.subtitle) lines.push(`    ${muted(model.subtitle)}`)
  lines.push('')
  model.options.forEach((option, index) => {
    const active = index === selectedIndex
    const pointer = active ? accent('❯') : ' '
    const number = muted(`${index + 1}.`)
    const label = active ? bold(option.label) : option.label
    lines.push(`  ${pointer} ${number} ${label}`)
  })
  lines.push('')
  lines.push(`    ${muted('↑/↓ or 1-9 to choose · Enter to select · q to quit')}`)
  for (const line of lines) process.stderr.write(`${line}\n`)
  return lines.length
}

function promptLine(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(message, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// Run the arrow-key menu loop. Returns the chosen option id, or null on quit.
function selectFromMenu(model) {
  return new Promise((resolve) => {
    let selected = 0
    let lineCount = renderMenu(model, selected)

    const stdin = process.stdin
    readline.emitKeypressEvents(stdin)
    const rawWasEnabled = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()

    const redraw = () => {
      clearMenu(lineCount)
      lineCount = renderMenu(model, selected)
    }

    const cleanup = () => {
      stdin.removeListener('keypress', onKeypress)
      if (stdin.isTTY) stdin.setRawMode(Boolean(rawWasEnabled))
      stdin.pause()
    }

    const finish = (value) => {
      cleanup()
      resolve(value)
    }

    const onKeypress = (str, key) => {
      if (!key) return
      if (key.ctrl && key.name === 'c') return finish({ quit: true, sigint: true })
      switch (key.name) {
        case 'up':
        case 'k':
          selected = (selected - 1 + model.options.length) % model.options.length
          redraw()
          return
        case 'down':
        case 'j':
          selected = (selected + 1) % model.options.length
          redraw()
          return
        case 'return':
        case 'enter':
          return finish({ id: model.options[selected].id })
        case 'q':
        case 'escape':
          return finish({ quit: true })
        default:
          break
      }
      if (str && /^[1-9]$/.test(str)) {
        const index = Number(str) - 1
        if (index < model.options.length) {
          selected = index
          return finish({ id: model.options[selected].id })
        }
      }
    }

    stdin.on('keypress', onKeypress)
  })
}

// Entry point for bare `hop`. Non-TTY / piped stdout falls back to help so
// scripts never block on an interactive prompt.
export async function runInteractive() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    printHelp()
    return
  }

  for (;;) {
    const state = await readInteractiveState()
    const model = buildMenuModel(state)
    const choice = await selectFromMenu(model)

    if (choice.sigint) {
      writeLine()
      writeLine(`  ${muted('Bye.')}`)
      return
    }
    if (choice.quit || choice.id === 'exit') {
      writeLine(`  ${muted('Bye.')}`)
      return
    }

    try {
      await dispatch(choice.id)
    } catch (error) {
      // A failed action returns to the menu with a one-line summary, never a
      // raw stack trace.
      const message = error instanceof Error ? error.message : String(error)
      writeLine()
      writeLine(`  ${danger('✗')} ${message}`)
    }
    writeLine()
    await promptLine(`  ${muted('Press Enter to return to the menu…')}`)
  }
}
