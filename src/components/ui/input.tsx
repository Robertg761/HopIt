import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors",
        "placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/25",
        className
      )}
      {...props}
    />
  )
}

export { Input }
