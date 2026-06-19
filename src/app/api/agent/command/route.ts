import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const cwd = process.cwd()
const agentCli = path.join(cwd, 'packages/agent/src/cli.js')
const demoStateArgs = [
  '--cloud',
  '.hopit-agent/demo/cloud.json',
  '--workspace',
  '.hopit-agent/demo/workspaces/hopit-core',
  '--journal',
  '.hopit-agent/demo/journal.ndjson',
  '--events',
  '.hopit-agent/demo/events.ndjson',
]

const commandMap = {
  demo: { label: 'Reset demo', cliCommand: 'demo' },
  sync: { label: 'Sync once', cliCommand: 'sync-once' },
  refresh: { label: 'Refresh', cliCommand: 'refresh' },
  recover: { label: 'Recover', cliCommand: 'recover' },
  review: { label: 'Open review', cliCommand: 'review-open' },
  merge: { label: 'Merge', cliCommand: 'merge' },
} as const

type AgentCommand = keyof typeof commandMap | 'edit'

let activeCommand: string | null = null

export async function POST(request: Request) {
  let command: AgentCommand

  try {
    const body = await request.json()
    command = body.command
  } catch {
    return commandError('invalid_request', 'Expected a JSON body with a command field.', 400)
  }

  if (command === 'edit') {
    return runExclusiveCommand(command, appendDemoEdit)
  }

  const commandConfig = commandMap[command]
  if (!commandConfig) {
    return commandError('unknown_command', 'Command is not allowed for the local prototype.', 400)
  }

  return runExclusiveCommand(command, async () => {
    const result = await runAgentCli(commandConfig.cliCommand)

    return NextResponse.json(
      {
        ok: result.exitCode === 0,
        command,
        label: commandConfig.label,
        ...result,
      },
      {
        status: result.exitCode === 0 ? 200 : 500,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  })
}

async function runExclusiveCommand(command: AgentCommand, action: () => Promise<NextResponse>) {
  if (activeCommand) {
    return commandError(
      'command_in_progress',
      `Another local agent action is still running: ${activeCommand}.`,
      409,
    )
  }

  activeCommand = command
  try {
    return await action()
  } finally {
    activeCommand = null
  }
}

async function appendDemoEdit() {
  const workspace = path.join(cwd, '.hopit-agent/demo/workspaces/hopit-core')
  const readmePath = path.join(workspace, 'README.md')
  const privatePath = path.join(workspace, '.private/agent-note.md')
  const timestamp = new Date().toISOString()

  await fs.mkdir(path.dirname(privatePath), { recursive: true })
  await fs.appendFile(readmePath, `\nPrototype edit from HopIt UI at ${timestamp}.\n`, 'utf8')
  await fs.appendFile(privatePath, `\nOwner-private UI edit at ${timestamp}.\n`, 'utf8')

  return NextResponse.json(
    {
      ok: true,
      command: 'edit',
      label: 'Edit demo files',
      exitCode: 0,
      stdout: `Edited README.md and .private/agent-note.md at ${timestamp}`,
      stderr: '',
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}

function runAgentCli(command: string) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [agentCli, command, ...demoStateArgs], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Agent command timed out: ${command}`))
    }, 15_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = capOutput(stdout + chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capOutput(stderr + chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  }).catch((error) => ({
    exitCode: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : 'Agent command failed.',
  }))
}

function capOutput(output: string) {
  return output.length > 16_000 ? output.slice(-16_000) : output
}

function commandError(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
