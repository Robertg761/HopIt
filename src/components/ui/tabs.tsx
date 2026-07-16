'use client'

import * as React from "react"

import { cn } from "@/lib/utils"

type TabsContextValue = {
  value: string
  setValue: (value: string) => void
  idBase: string
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

function useTabs() {
  const context = React.useContext(TabsContext)
  if (!context) throw new Error("Tabs components must be used inside <Tabs>")
  return context
}

function Tabs({
  value,
  onValueChange,
  defaultValue,
  className,
  children,
}: {
  value?: string
  onValueChange?: (value: string) => void
  defaultValue?: string
  className?: string
  children: React.ReactNode
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? "")
  const idBase = React.useId()
  const current = value ?? internal
  const setValue = React.useCallback(
    (next: string) => {
      setInternal(next)
      onValueChange?.(next)
    },
    [onValueChange]
  )

  return (
    <TabsContext.Provider value={{ value: current, setValue, idBase }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const triggers = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
    const currentIndex = triggers.indexOf(document.activeElement as HTMLButtonElement)
    if (currentIndex === -1 || triggers.length === 0) return

    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? triggers.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % triggers.length
          : (currentIndex - 1 + triggers.length) % triggers.length
    triggers[nextIndex].focus()
    triggers[nextIndex].click()
  }

  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn("flex w-full max-w-full items-center gap-0 overflow-x-auto border-b border-border", className)}
    >
      {children}
    </div>
  )
}

function TabsTrigger({
  value,
  className,
  children,
  count,
}: {
  value: string
  className?: string
  children: React.ReactNode
  count?: number
}) {
  const tabs = useTabs()
  const active = tabs.value === value

  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.idBase}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${tabs.idBase}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      onClick={() => tabs.setValue(value)}
      className={cn(
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-[var(--signal-orange)] text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
        className
      )}
    >
      {children}
      {typeof count === "number" ? (
        <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  )
}

function TabsContent({
  value,
  className,
  children,
}: {
  value: string
  className?: string
  children: React.ReactNode
}) {
  const tabs = useTabs()
  if (tabs.value !== value) return null

  return (
    <div
      role="tabpanel"
      id={`${tabs.idBase}-panel-${value}`}
      aria-labelledby={`${tabs.idBase}-tab-${value}`}
      className={cn("pt-4 outline-none", className)}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
