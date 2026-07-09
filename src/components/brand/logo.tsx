import * as React from 'react'

import { cn } from '@/lib/utils'

export function HopItLogo({
  size = 26,
  className,
  showWordmark = true,
}: {
  size?: number
  className?: string
  showWordmark?: boolean
}) {
  const clipId = React.useId()

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label={showWordmark ? undefined : 'HopIt'}
        aria-hidden={showWordmark ? true : undefined}
        className="shrink-0"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="2" y="2" width="44" height="44" rx="14" />
          </clipPath>
        </defs>
        <rect x="2" y="2" width="44" height="44" rx="14" fill="var(--signal)" />
        <g clipPath={`url(#${clipId})`}>
          <path d="M-4 41L17 20" stroke="#17352e" strokeWidth="6" />
          <path d="M16 32L30 18" stroke="#17352e" strokeWidth="6" />
          <path d="M29 25L48 6" stroke="#17352e" strokeWidth="6" />
          <circle cx="17" cy="20" r="3.2" fill="#f16c43" stroke="#17352e" strokeWidth="2" />
          <circle cx="30" cy="18" r="3.2" fill="#f3f0e6" stroke="#17352e" strokeWidth="2" />
        </g>
      </svg>
      {showWordmark ? (
        <span className="text-[0.9rem] font-black uppercase leading-none tracking-[0.16em]">HopIt</span>
      ) : null}
    </span>
  )
}
