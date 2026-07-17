'use strict'

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises')
const { spawnSync } = require('node:child_process')

async function waitForExit(pid, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('HopIt did not exit in time to install the update.')
}

async function installStagedUpdate({ parentPid, currentApp, stagedApp, backupApp, launch = true }) {
  await waitForExit(parentPid)
  await fs.rm(backupApp, { recursive: true, force: true })
  await fs.rename(currentApp, backupApp)
  try {
    await fs.rename(stagedApp, currentApp)
    if (launch) {
      const opened = spawnSync('/usr/bin/open', ['-n', currentApp], { encoding: 'utf8' })
      if (opened.status !== 0) throw new Error(opened.stderr || opened.stdout || 'Unable to reopen HopIt.')
    }
  } catch (error) {
    await fs.rm(currentApp, { recursive: true, force: true }).catch(() => {})
    await fs.rename(backupApp, currentApp).catch(() => {})
    throw error
  }
}

module.exports = { installStagedUpdate, waitForExit }

if (require.main === module) {
  const [parentPid, currentApp, stagedApp, backupApp] = process.argv.slice(2)
  installStagedUpdate({ parentPid: Number(parentPid), currentApp, stagedApp, backupApp })
    .catch(async (error) => {
      const logPath = `${backupApp}.update-error.log`
      await fs.writeFile(logPath, `${error.stack || error}\n`, 'utf8').catch(() => {})
      spawnSync('/usr/bin/open', ['-n', currentApp], { encoding: 'utf8' })
      process.exitCode = 1
    })
}
