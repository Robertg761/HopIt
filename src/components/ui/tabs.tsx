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
  return (
    <div
      role="tablist"
      className={cn("flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full border border-border bg-card/70 p-1", className)}
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
      onClick={() => tabs.setValue(value)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
