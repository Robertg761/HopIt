import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-colors",
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

export { Textarea }
