export const d1CloudServiceType: 'cloudflare-d1-graph'

export type D1Options = Record<string, unknown>
export type D1Environment = Record<string, string | undefined>

export function d1ConfigFromOptions(options?: D1Options, env?: D1Environment): Record<string, unknown>
export function isD1Configured(options?: D1Options, env?: D1Environment): boolean
export function createD1Backend(options?: D1Options, env?: D1Environment): CloudflareD1HopBackend

export const d1SchemaStatements: string[]

export class CloudflareD1HopBackend {
  constructor(config: Record<string, unknown>)
  config: Record<string, unknown>
  codebaseId: string
  type: typeof d1CloudServiceType
  location: string
  schemaEnsured: boolean
  ensureSchema(): Promise<void>
  readGraph(codebaseId?: string): Promise<unknown>
  writeGraph(graph: unknown): Promise<unknown>
  appendEvent(event: unknown): Promise<unknown>
  [key: string]: any
}
