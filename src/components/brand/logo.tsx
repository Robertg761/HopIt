import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * HopIt mark — rabbit-ear "hop" stroke over a brand-gradient tile,
 * with a forward motion arc underneath.
 */
export function HopItLogo({
  size = 26,
  className,
  showWordmark = true,
}: {
  size?: number
  className?: string
  showWordmark?: boolean
}) {
  const gradientId = React.useId()

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="HopIt"
        className="shrink-0"
      >
        <defs>
          <linearGradient id={gradientId} x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--hop-logo-start)" />
            <stop offset="1" stopColor="var(--hop-logo-end)" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="44" height="44" rx="12" fill={`url(#${gradientId})`} />
        <path
          d="M16 34V18.5c0-1.5 1.8-2.3 2.9-1.2l4.6 4.6c.5.5 1.3.5 1.8 0l5.6-5.6c1.1-1.1 2.9-.3 2.9 1.2V34"
          stroke="#ffffff"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <path
          d="M14 38c4-2.5 9-2.5 13 0s9 2.5 13 0"
          stroke="#ffffff"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
      </svg>
      {showWordmark ? (
        <span className="text-[0.9375rem] font-semibold leading-none tracking-tight">HopIt</span>
      ) : null}
    </span>
  )
}
