import { d1ConfigFromOptions } from './config.js'
import { attachAccessMethods } from './access.js'
import { attachActionMethods } from './actions.js'
import { attachClientMethods } from './client.js'
import { attachCollaborationMethods } from './collaboration.js'
import { attachGraphMethods } from './graph.js'
import { attachKeyMethods } from './keys.js'
import { attachMemberMethods } from './members.js'
import { attachSchemaMethods } from './schema-methods.js'
import { attachSessionMethods } from './sessions.js'

export { d1CloudServiceType, d1ConfigFromOptions, isD1Configured } from './config.js'
export { d1SchemaStatements } from './schema.js'

export function createD1Backend(options = {}, env = process.env) {
  return new CloudflareD1HopBackend(d1ConfigFromOptions(options, env))
}

export class CloudflareD1HopBackend {
  constructor(config) {
    this.config = config
    this.codebaseId = config.codebaseId
    this.type = 'cloudflare-d1-graph'
    this.location = `d1:${config.databaseId ?? 'unconfigured'}:${this.codebaseId}`
    this.schemaEnsured = false
  }
}

attachSchemaMethods(CloudflareD1HopBackend)
attachGraphMethods(CloudflareD1HopBackend)
attachAccessMethods(CloudflareD1HopBackend)
attachActionMethods(CloudflareD1HopBackend)
attachMemberMethods(CloudflareD1HopBackend)
attachCollaborationMethods(CloudflareD1HopBackend)
attachSessionMethods(CloudflareD1HopBackend)
attachKeyMethods(CloudflareD1HopBackend)
attachClientMethods(CloudflareD1HopBackend)
