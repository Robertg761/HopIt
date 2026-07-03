'use client'

import * as React from 'react'

import { Sidebar } from '@/components/shell/sidebar'
import { Topbar } from '@/components/shell/topbar'
import { CommandPalette } from '@/components/shell/command-palette'
import { WorkspaceProvider } from '@/components/workspace/workspace-provider'

export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [navOpen, setNavOpen] = React.useState(false)

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
      <div className="flex min-h-dvh">
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 border-r border-border bg-background lg:block">
          <Sidebar />
        </aside>

        {navOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setNavOpen(false)}
              className="absolute inset-0 bg-black/50 animate-in fade-in duration-150"
              tabIndex={-1}
            />
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-background shadow-2xl animate-in slide-in-from-left duration-200">
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col lg:pl-56">
          <Topbar onOpenPalette={() => setPaletteOpen(true)} onOpenNav={() => setNavOpen(true)} />
          <main id="page-main" className="flex-1">
            {children}
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </WorkspaceProvider>
  )
}
