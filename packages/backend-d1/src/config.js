import { stringOrNull } from './helpers/base.js'

export const d1CloudServiceType = 'cloudflare-d1-graph'
export const defaultD1ApiBaseUrl = 'https://api.cloudflare.com/client/v4'
export const defaultCodebaseId = 'hopit'

export function d1ConfigFromOptions(options = {}, env = process.env) {
  return {
    accountId: stringOrNull(options['d1-account-id']) ?? stringOrNull(env.HOPIT_D1_ACCOUNT_ID) ?? stringOrNull(env.CLOUDFLARE_ACCOUNT_ID),
    databaseId: stringOrNull(options['d1-database-id']) ?? stringOrNull(env.HOPIT_D1_DATABASE_ID),
    apiToken: stringOrNull(options['d1-api-token']) ?? stringOrNull(env.HOPIT_D1_API_TOKEN) ?? stringOrNull(env.CLOUDFLARE_API_TOKEN),
    apiBaseUrl: stringOrNull(options['d1-api-base-url']) ?? stringOrNull(env.HOPIT_D1_API_BASE_URL) ?? defaultD1ApiBaseUrl,
    codebaseId: stringOrNull(options['codebase-id']) ?? stringOrNull(env.HOPIT_CODEBASE_ID) ?? defaultCodebaseId,
    agentSessionToken: stringOrNull(options['session-token']) ?? stringOrNull(options.agentSessionToken) ?? stringOrNull(env.HOPIT_AGENT_SESSION_TOKEN),
    assumeSchema: booleanOption(options['assume-schema']) ?? truthyEnv(env.HOPIT_D1_ASSUME_SCHEMA),
    multiTenant: booleanOption(options['multi-tenant']) ?? truthyEnv(env.HOPIT_MULTITENANT),
    serverActorUserId: stringOrNull(options['server-actor-user-id']),
    serverActorSecret: stringOrNull(options['server-actor-secret']) ?? stringOrNull(env.HOPIT_D1_SERVER_ACTOR_SECRET),
  }
}

// When multi-tenancy is on and the caller carried an authenticated user id, the
// dashboard presents a per-request server-actor credential the Worker re-checks
// against codebase ownership/membership, instead of the omnipotent proxy token.
// With the flag off this is always false, so the proxy path is byte-for-byte
// unchanged.
export function usesServerActorAuth(config) {
  return Boolean(config.multiTenant && config.serverActorUserId && config.serverActorSecret)
}

export function isD1Configured(options = {}, env = process.env) {
  const config = d1ConfigFromOptions(options, env)
  if (usesCloudflareD1Api(config)) {
    return Boolean(config.accountId && config.databaseId && config.apiToken)
  }
  return Boolean(d1AuthorizationToken(config)) || usesServerActorAuth(config)
}

export function usesCloudflareD1Api(config) {
  return (config.apiBaseUrl ?? defaultD1ApiBaseUrl).replace(/\/+$/, '') === defaultD1ApiBaseUrl
}

export function d1AuthorizationToken(config) {
  return stringOrNull(config.apiToken) ?? stringOrNull(config.agentSessionToken)
}

export function schemaCacheKey(config) {
  return [
    (config.apiBaseUrl ?? defaultD1ApiBaseUrl).replace(/\/+$/, ''),
    config.accountId ?? '',
    config.databaseId ?? '',
  ].join('|')
}

function booleanOption(value) {
  if (value === true || value === false) return value
  if (typeof value !== 'string') return null
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return null
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

export function usesScopedD1SessionAuth(config) {
  return !stringOrNull(config.apiToken) && Boolean(stringOrNull(config.agentSessionToken)) && !usesCloudflareD1Api(config)
}
