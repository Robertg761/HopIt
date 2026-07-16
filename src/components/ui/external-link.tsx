import * as React from 'react'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export function ExternalLink({ children, className, rel, ...props }: React.ComponentProps<'a'>) {
  return (
    <a
      {...props}
      target="_blank"
      rel={rel ?? 'noreferrer'}
      className={cn('inline-flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
    >
      {children}
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
