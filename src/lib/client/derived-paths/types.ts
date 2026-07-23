/**
 * Client-facing shapes for the derived-paths settings surface (GR-C1,
 * decisions §6). These mirror the `/api/codebases/derived-paths` route
 * envelope, a thin read-only wrapper over the backend `readCodebaseSettings`
 * method. Mutation happens from the agent CLI (`hop derived add|remove
 * <path>`), never from the dashboard.
 */

export type DerivedPathOverrides = {
  add: string[]
  remove: string[]
}

export type DerivedPathsError = {
  code: string
  message: string
}

export type DerivedPathsResponse = {
  ok: boolean
  codebaseId: string | null
  builtin?: string[]
  overrides?: DerivedPathOverrides
  error?: DerivedPathsError
}
