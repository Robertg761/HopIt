'use client'

import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

import { ManagedCaption } from './shared'
import { useDerivedPaths } from './use-derived-paths'

/**
 * Derived-paths settings card (GR-C1, decisions §6). Flag-gated behind
 * `NEXT_PUBLIC_DERIVED_PATHS_SETTINGS` while the dashboard settings surface
 * stays behind a flag; the settings page only renders this when the flag is
 * on. Read-only, like the other CLI-managed cards on this page: overrides are
 * edited with `hop derived add|remove <path>`.
 */
export function DerivedPathsCard({ codebaseId }: { codebaseId: string | null }) {
  const state = useDerivedPaths(codebaseId)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Derived paths</CardTitle>
        <CardDescription>Local-only generated folders that never sync (node_modules, build output, …).</CardDescription>
      </CardHeader>
      <CardContent>
        {!codebaseId || !state || state.status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.status === 'error' ? (
          <p className="text-sm text-muted-foreground">{state.error.message}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Built-in ({state.data.builtin.length})</p>
              <div className="flex flex-wrap gap-1.5">
                {state.data.builtin.map((rule) => (
                  <Badge key={rule} tone="outline">
                    {rule}
                  </Badge>
                ))}
              </div>
            </div>
            {state.data.overrides.add.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Added (custom, also derived)</p>
                <div className="flex flex-wrap gap-1.5">
                  {state.data.overrides.add.map((rule) => (
                    <Badge key={rule} tone="hop">
                      {rule}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            {state.data.overrides.remove.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Un-derived (synced despite being built-in)</p>
                <div className="flex flex-wrap gap-1.5">
                  {state.data.overrides.remove.map((rule) => (
                    <Badge key={rule} tone="amber">
                      {rule}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <ManagedCaption>
          Edit overrides with <span className="font-mono">hop derived add|remove &lt;path&gt;</span>. Derived paths are
          never journaled, never synced, and never counted in presence.
        </ManagedCaption>
      </CardFooter>
    </Card>
  )
}
