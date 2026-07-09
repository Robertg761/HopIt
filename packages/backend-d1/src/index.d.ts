export const d1CloudServiceType: 'cloudflare-d1-graph'

export type D1Options = Record<string, unknown>
export type D1Environment = Record<string, string | undefined>

export function d1ConfigFromOptions(options?: D1Options, env?: D1Environment): Record<string, unknown>
export function isD1Configured(options?: D1Options, env?: D1Environment): boolean
export function createD1Backend(options?: D1Options, env?: D1Environment): CloudflareD1HopBackend

export const d1SchemaStatements: string[]
export function attachTextDiff(result: unknown, filePath: string, readFileBody: (...args: unknown[]) => Promise<unknown>): Promise<unknown>
export function buildFileVersionRowForEntry(input: Record<string, unknown>): unknown
export function buildFileVersionRows(input: Record<string, unknown>): unknown[]
export function compareVersionRows(versions: unknown[], leftRevision: number, rightRevision: number, options?: Record<string, unknown>): unknown
export function createCompareBlobReader(options?: Record<string, unknown>): unknown
export function retainedBlobKeysForVersions(versions: unknown[]): Set<string>

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
  compareRevisions(leftRevision: number, rightRevision: number, requester?: Record<string, unknown>): Promise<unknown>
  listFileVersions(codebaseId?: string): Promise<unknown[]>
  retainedBlobKeysForFileVersions(codebaseId?: string): Promise<Set<string>>
  appendEvent(event: unknown): Promise<unknown>
  [key: string]: any
}
