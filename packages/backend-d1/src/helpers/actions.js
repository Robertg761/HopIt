import { parseJson } from './base.js'

export function actionCommandForKind(kind) {
  if (kind === 'lint') return { command: 'npm', args: ['run', 'lint'] }
  if (kind === 'test') return { command: 'npm', args: ['test'] }
  if (kind === 'build') return { command: 'npm', args: ['run', 'build'] }
  throw new Error('Action kind must be lint, test, or build.')
}

export function summarizeActionJob(row) {
  if (!row) return null
  const job = row.job_id
    ? {
        jobId: row.job_id,
        codebaseId: row.codebase_id,
        kind: row.kind,
        command: row.command,
        args: parseJson(row.args_json, []),
        status: row.status,
        requestedByUserId: row.requested_by_user_id,
        runnerId: row.runner_id ?? undefined,
        exitCode: row.exit_code ?? null,
        stdout: row.stdout ?? undefined,
        stderr: row.stderr ?? undefined,
        summary: row.summary ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        claimedAt: row.claimed_at ?? undefined,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.finished_at ?? undefined,
      }
    : row
  return {
    jobId: job.jobId,
    codebaseId: job.codebaseId,
    kind: job.kind,
    command: job.command,
    args: Array.isArray(job.args) ? job.args : [],
    status: job.status,
    requestedByUserId: job.requestedByUserId,
    runnerId: job.runnerId ?? null,
    exitCode: job.exitCode ?? null,
    stdout: job.stdout ?? null,
    stderr: job.stderr ?? null,
    summary: job.summary ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    claimedAt: job.claimedAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
  }
}

export function actionSummary(status, exitCode) {
  if (status === 'succeeded') return 'Command completed successfully.'
  if (status === 'cancelled') return 'Command was cancelled.'
  return `Command failed${Number.isInteger(exitCode) ? ` with exit code ${exitCode}` : ''}.`
}

export function capOutput(value) {
  return typeof value === 'string' ? value.slice(-20_000) : undefined
}
