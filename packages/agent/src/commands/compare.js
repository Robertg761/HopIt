// @ts-check
import { createCloudGraphService, visibilityRequestFromOptions } from '../cloud/d1-graph-service.js'

export async function compareCloudRevisions(options) {
  const leftRevision = parseRevisionOption(options.from, '--from')
  const rightRevision = parseRevisionOption(options.to, '--to')
  const cloudService = createCloudGraphService(options)
  if (typeof cloudService.compareRevisions !== 'function') {
    throw new Error('Configured cloud service does not support revision compare.')
  }
  const result = await cloudService.compareRevisions(leftRevision, rightRevision, {
    ...visibilityRequestFromOptions(options),
    path: options.path ?? options.file,
  })
  console.log(JSON.stringify(result, null, 2))
}

function parseRevisionOption(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Missing or invalid ${name} <revision>.`)
  return parsed
}
