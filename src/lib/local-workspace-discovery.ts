import { spawn } from 'node:child_process'
import path from 'node:path'
import { localCommandProfile, mergeLocalProductionEnv } from '@/lib/local-production-env'

const cwd = process.cwd()
const agentCli = path.join(cwd, 'packages/agent/src/cli.js')
const discoveryTimeoutMs = 15_000

export type LocalWorkspaceDiscovery = {
  ok?: boolean
  root?: unknown
  cloud?: unknown
  codebases?: unknown[]
  error?: string | null
}

export async function readLocalWorkspaceDiscovery(): Promise<LocalWorkspaceDiscovery | null> {
  if (process.env.VERCEL) return null

  const env = mergeLocalProductionEnv(process.env)
  const profile = localCommandProfile(env)
  const args = ['workspace', 'discover', '--json']
  if (profile === 'production') args.push('--profile', 'production')

  const result = await runAgentCli(args, env)
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: result.stderr || 'Workspace discovery failed.',
    }
  }

  const parsed = parseLastJsonObject(result.stdout)
  return isRecord(parsed) ? parsed as LocalWorkspaceDiscovery : null
}

function runAgentCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [agentCli, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Workspace discovery timed out.'))
    }, discoveryTimeoutMs)

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
    stderr: error instanceof Error ? error.message : 'Workspace discovery failed.',
  }))
}

function parseLastJsonObject(text: string): unknown {
  const start = text.lastIndexOf('\n{')
  const slice = start >= 0 ? text.slice(start + 1) : text
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function capOutput(output: string) {
  return output.length > 64_000 ? output.slice(-64_000) : output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
