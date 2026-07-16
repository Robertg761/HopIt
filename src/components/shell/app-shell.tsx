'use client'

import * as React from 'react'

import { Topbar } from '@/components/shell/topbar'
import { CommandPalette } from '@/components/shell/command-palette'
import { UnsavedChangesProvider } from '@/components/shell/unsaved-changes-provider'
import { WorkspaceProvider } from '@/components/workspace/workspace-provider'
import { SkipLink } from '@/components/ui/skip-link'

export function AppShell({ children, serviceAdmin = false }: { children: React.ReactNode; serviceAdmin?: boolean }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false)

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <WorkspaceProvider>
      <UnsavedChangesProvider>
        <div className="relative flex min-h-dvh flex-col">
          <SkipLink href="#page-main" />
          <Topbar serviceAdmin={serviceAdmin} onOpenPalette={() => setPaletteOpen(true)} />
          <main id="page-main" className="relative flex-1">
            {children}
          </main>
        </div>

        <CommandPalette serviceAdmin={serviceAdmin} open={paletteOpen} onOpenChange={setPaletteOpen} />
      </UnsavedChangesProvider>
    </WorkspaceProvider>
  )
}
