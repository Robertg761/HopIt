import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        outline: "border border-border text-muted-foreground",
        hop: "bg-hop-soft text-hop-soft-foreground",
        iris: "bg-iris-soft text-iris-soft-foreground",
        amber: "bg-amber-soft text-amber-soft-foreground",
        danger: "bg-danger-soft text-danger-soft-foreground",
        info: "bg-info-soft text-info-soft-foreground",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

export { Badge, badgeVariants }
