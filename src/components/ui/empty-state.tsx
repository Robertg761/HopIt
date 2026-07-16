import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  titleAs: Title = 'p',
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  titleAs?: 'h1' | 'h2' | 'p'
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center",
        className
      )}
    >
      {Icon ? (
        <div className="mb-1 flex size-10 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
      ) : null}
      <Title className="text-base font-semibold text-foreground">{title}</Title>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
