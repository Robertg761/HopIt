import { spawn } from 'node:child_process'
import path from 'node:path'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const cwd = process.cwd()
const agentCli = path.join(cwd, 'packages/agent/src/cli.js')
const localStateArgs = [
  '--cloud',
  '.hopit-agent/cloud.json',
  '--workspace',
  '.hopit-agent/workspaces/hopit-core',
  '--journal',
  '.hopit-agent/journal.ndjson',
  '--events',
  '.hopit-agent/events.ndjson',
]
const remoteStateArgs = [
  ...localStateArgs,
  ...optionArg('--convex-url', process.env.HOPIT_CONVEX_URL ?? process.env.CONVEX_URL),
  ...optionArg('--agent-token', process.env.HOPIT_AGENT_TOKEN),
  ...optionArg('--codebase-id', process.env.HOPIT_CODEBASE_ID),
]

const commandMap = {
  sync: { label: 'Sync once', cliCommand: 'sync-once' },
  refresh: { label: 'Refresh', cliCommand: 'refresh' },
  recover: { label: 'Recover', cliCommand: 'recover' },
  review: { label: 'Open review', cliCommand: 'review-open' },
  merge: { label: 'Merge', cliCommand: 'merge' },
} as const

type AgentCommand = keyof typeof commandMap

let activeCommand: string | null = null

export async function POST(request: Request) {
  let command: AgentCommand

  try {
    const body = await request.json()
    command = body.command
  } catch {
    return commandError('invalid_request', 'Expected a JSON body with a command field.', 400)
  }

  const commandConfig = commandMap[command]
  if (!commandConfig) {
    return commandError('unknown_command', 'Command is not allowed for the local prototype.', 400)
  }

  if (process.env.VERCEL) {
    return commandError(
      'local_agent_required',
      'Hosted HopIt cannot run local workspace commands. Run the HopIt agent on your machine to sync this codebase.',
      501,
    )
  }

  return runExclusiveCommand(command, async () => {
    const result = await runAgentCli(commandConfig.cliCommand)

    return NextResponse.json(
      {
        ok: result.exitCode === 0,
        command,
        label: commandConfig.label,
        summary: summarizeCommandResult(command, result),
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

function summarizeCommandResult(
  command: keyof typeof commandMap,
  result: { exitCode: number | null; stdout: string; stderr: string },
) {
  if (result.exitCode !== 0) return result.stderr || 'Agent command failed.'

  if (command === 'sync') return summarizeSync(result.stdout)
  if (command === 'refresh') return summarizeRefresh(result.stdout)
  if (command === 'recover') return summarizeRecover(result.stdout)
  if (command === 'review') return 'Opened the active change set for review.'
  if (command === 'merge') return 'Merged the active change set into Main.'

  return 'Agent command completed.'
}

function summarizeSync(stdout: string) {
  const writes = matchNumber(stdout, /"writes":(\d+)/)
  if (writes === null) return 'Synced local workspace changes.'
  return `Synced ${writes} write${writes === 1 ? '' : 's'} into the active change set.`
}

function summarizeRefresh(stdout: string) {
  const written = matchNumber(stdout, /"written":(\d+)/)
  const deleted = matchNumber(stdout, /"deleted":(\d+)/)
  if (written === null && deleted === null) return 'Refreshed the managed workspace.'
  return `Refreshed workspace: ${written ?? 0} written, ${deleted ?? 0} deleted.`
}

function summarizeRecover(stdout: string) {
  const failed = matchNumber(stdout, /"failed":(\d+)/)
  if (failed && failed > 0) return `Recovery found ${failed} unresolved entr${failed === 1 ? 'y' : 'ies'}.`
  return 'Recovered pending journal entries.'
}

function matchNumber(text: string, pattern: RegExp) {
  const match = text.match(pattern)
  return match ? Number(match[1]) : null
}

function runAgentCli(command: string) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [agentCli, command, ...remoteStateArgs], {
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

function optionArg(name: string, value: string | undefined) {
  return value ? [name, value] : []
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
