// @ts-check
// Per-project on/off switch for the warn-only outbound secret scanner
// (decisions doc §7). Mirrors `hop trail summaries on|off`.
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { reportResult } from '../output.js'

export async function runSecretsCommand(state = 'status', options = {}) {
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)

  if (state === 'status') {
    const settings = await service.readCodebaseSettings(codebaseId)
    const result = { ok: true, codebaseId, secretScanningEnabled: settings.secretScanningEnabled }
    reportResult(options, result, ({ line, success, caution }) => {
      line(
        settings.secretScanningEnabled
          ? `  ${success('✓')} Secret scanning on for ${codebaseId}`
          : `  ${caution('○')} Secret scanning off for ${codebaseId}`,
      )
    })
    return result
  }

  if (state !== 'on' && state !== 'off') {
    throw new Error('Usage: hop secrets on|off|status')
  }

  const updated = await service.setSecretScanning(codebaseId, { enabled: state === 'on' })
  const result = { ok: true, ...updated }
  reportResult(options, result, ({ line, success, caution }) => {
    line(
      updated.secretScanningEnabled
        ? `  ${success('✓')} Secret scanning on for ${codebaseId}`
        : `  ${caution('○')} Secret scanning off for ${codebaseId}`,
    )
  })
  return result
}

function resolveCodebaseId(service, options) {
  return (
    options['codebase-id'] ||
    service.codebaseId ||
    process.env.HOPIT_CODEBASE_ID ||
    'hopit'
  )
}
