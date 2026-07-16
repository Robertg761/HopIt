'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'

type UnsavedChangesContextValue = {
  confirmOrRun: (action: () => void) => void
  setBlocker: (id: string, message: string | null) => void
}

const UnsavedChangesContext = React.createContext<UnsavedChangesContextValue | null>(null)

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [blockers, setBlockers] = React.useState<Record<string, string>>({})
  const [pendingAction, setPendingAction] = React.useState<(() => void) | null>(null)
  const hasUnsavedChanges = Object.keys(blockers).length > 0
  const description = Object.values(blockers)[0] ?? 'You have unsaved changes.'

  const setBlocker = React.useCallback((id: string, message: string | null) => {
    setBlockers((current) => {
      if (message === null) {
        if (!(id in current)) return current
        const next = { ...current }
        delete next[id]
        return next
      }
      if (current[id] === message) return current
      return { ...current, [id]: message }
    })
  }, [])

  const confirmOrRun = React.useCallback((action: () => void) => {
    if (!hasUnsavedChanges) {
      action()
      return
    }
    setPendingAction(() => action)
  }, [hasUnsavedChanges])

  React.useEffect(() => {
    if (!hasUnsavedChanges) return
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges])

  React.useEffect(() => {
    if (!hasUnsavedChanges) return
    function onDocumentClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.origin !== window.location.origin) return
      if (
        destination.pathname === window.location.pathname
        && destination.search === window.location.search
        && destination.hash
      ) return

      event.preventDefault()
      event.stopPropagation()
      confirmOrRun(() => router.push(`${destination.pathname}${destination.search}${destination.hash}`))
    }
    document.addEventListener('click', onDocumentClick, true)
    return () => document.removeEventListener('click', onDocumentClick, true)
  }, [confirmOrRun, hasUnsavedChanges, router])

  function discardAndContinue() {
    const action = pendingAction
    setPendingAction(null)
    action?.()
  }

  return (
    <UnsavedChangesContext.Provider value={{ confirmOrRun, setBlocker }}>
      {children}
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
        title="Discard unsaved changes?"
        description={description}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingAction(null)}>Keep editing</Button>
            <Button variant="destructive" onClick={discardAndContinue}>Discard changes</Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Continuing will permanently discard the edits that have not been saved.
        </p>
      </Dialog>
    </UnsavedChangesContext.Provider>
  )
}

export function useUnsavedChanges() {
  const context = React.useContext(UnsavedChangesContext)
  if (!context) throw new Error('useUnsavedChanges must be used inside UnsavedChangesProvider')
  return context
}

export function useUnsavedChangesBlocker(active: boolean, message: string) {
  const id = React.useId()
  const { setBlocker } = useUnsavedChanges()

  React.useEffect(() => {
    setBlocker(id, active ? message : null)
    return () => setBlocker(id, null)
  }, [active, id, message, setBlocker])
}
