'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function Dialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  className?: string
  children?: React.ReactNode
  footer?: React.ReactNode
}) {
  const previouslyFocused = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    if (open) previouslyFocused.current = document.activeElement as HTMLElement | null
  }, [open])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:duration-100 data-[state=open]:duration-150" />
        <DialogPrimitive.Content
          {...(!description ? { 'aria-describedby': undefined } : {})}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            previouslyFocused.current?.focus()
          }}
          className={cn(
            'fixed left-1/2 top-[10vh] z-50 max-h-[80dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 data-[state=closed]:duration-100 data-[state=open]:duration-150',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-base font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="-mr-1.5 -mt-1.5 text-muted-foreground"
              >
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="px-6 py-5">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { Dialog }
