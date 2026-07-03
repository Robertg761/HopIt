import * as React from "react"

import { cn } from "@/lib/utils"

export type StatusDotTone = "hop" | "iris" | "amber" | "danger" | "info" | "neutral"

const toneClasses: Record<StatusDotTone, string> = {
  hop: "bg-hop",
  iris: "bg-iris",
  amber: "bg-amber",
  danger: "bg-destructive",
  info: "bg-info",
  neutral: "bg-muted-foreground/50",
}

/** Small colored status indicator; `pulse` adds the live halo. */
function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: StatusDotTone
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-2 shrink-0 rounded-full",
        toneClasses[tone],
        pulse && "status-pulse",
        className
      )}
    />
  )
}

export { StatusDot }
