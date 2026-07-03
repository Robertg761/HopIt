import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-4 animate-spin text-muted-foreground", className)} />
}

export { Spinner }
