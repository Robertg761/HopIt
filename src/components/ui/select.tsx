import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/** Styled native select — reliable, accessible, no portal machinery. */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        data-slot="select"
        className={cn(
          "h-8 w-full appearance-none rounded-lg border border-input bg-transparent pl-2.5 pr-8 text-sm text-foreground transition-colors",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 outline-none",
          "disabled:pointer-events-none disabled:opacity-50",
          "[&>option]:bg-popover [&>option]:text-popover-foreground"
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export { Select }
