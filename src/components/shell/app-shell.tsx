'use client'

import * as React from 'react'

import { Topbar } from '@/components/shell/topbar'
import { CommandPalette } from '@/components/shell/command-palette'
import { WorkspaceProvider } from '@/components/workspace/workspace-provider'

export function AppShell({ children }: { children: React.ReactNode }) {
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
      <div className="relative flex min-h-dvh flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main id="page-main" className="relative flex-1">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </WorkspaceProvider>
  )
}
