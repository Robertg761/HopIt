import * as React from 'react'

import { cn } from '@/lib/utils'

type FieldControlProps = {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

/** Label + control + optional hint/error, on the 8px grid. */
function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: string
  hint?: string
  error?: string
  htmlFor?: string
  className?: string
  children: React.ReactElement<FieldControlProps>
}) {
  const generatedId = React.useId()
  const controlId = htmlFor ?? children.props.id ?? `${generatedId}-control`
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [children.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {React.cloneElement(children, {
        id: children.props.id ?? controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : children.props['aria-invalid'],
      })}
      {hint ? <p id={hintId} className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

export { Field }
