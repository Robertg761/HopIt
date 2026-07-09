import * as React from 'react'

import { cn } from '@/lib/utils'

export function PageScaffold({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="page-enter mx-auto w-full max-w-[92rem] px-4 pb-12 pt-7 sm:px-6 sm:pt-10 lg:px-10 xl:px-12">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-foreground/15 pb-6 sm:mb-10 sm:pb-8">
        <div className="min-w-0">
          <p className="mono-label mb-3 flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-1.5 rotate-45 bg-[var(--signal-orange)]" />
            Workspace / {title}
          </p>
          <h1 className="font-display text-[2.35rem] leading-[0.96] tracking-[-0.045em] sm:text-[3.25rem]">
            {title}
          </h1>
          {description ? (
            <p className="mt-3 max-w-2xl text-[0.95rem] leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn('space-y-5 sm:space-y-6', className)}>{children}</div>
    </div>
  )
}
