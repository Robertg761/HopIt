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
    <div className="page-enter mx-auto w-full max-w-[1280px] px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn('space-y-4', className)}>{children}</div>
    </div>
  )
}
