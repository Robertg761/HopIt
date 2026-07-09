import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[1.5rem] border border-dashed border-foreground/20 bg-card/50 px-6 py-16 text-center",
        className
      )}
    >
      {Icon ? (
        <div className="mb-2 flex size-12 rotate-3 items-center justify-center rounded-2xl bg-[var(--signal)] text-[#17352e] shadow-[5px_5px_0_#17352e]">
          <Icon className="size-5 -rotate-3" />
        </div>
      ) : null}
      <p className="font-display text-xl tracking-[-0.025em] text-foreground">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
