import * as React from "react"

import { cn } from "@/lib/utils"

/** Label + control + optional hint, on the 8px grid. */
function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export { Field }
