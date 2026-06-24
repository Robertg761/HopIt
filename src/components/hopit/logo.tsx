import * as React from 'react'

type LogoProps = {
  size?: number
  className?: string
  showWordmark?: boolean
  variant?: 'default' | 'mono-light'
}

/**
 * HopIt logo — a stylized "hop" mark combining a rabbit-ear silhouette
 * with a forward-leaning motion arc. Designed to feel friendly and kinetic.
 */
export function HopItLogo({
  size = 32,
  className,
  showWordmark = true,
  variant = 'default',
}: LogoProps) {
  const gradientId = React.useId()
  const isMono = variant === 'mono-light'

  return (
    <div className={`flex items-center gap-2.5 ${className ?? ''}`}>
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
          {!isMono && (
            <linearGradient id={gradientId} x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
              <stop stopColor="#10b981" />
              <stop offset="1" stopColor="#8b5cf6" />
            </linearGradient>
          )}
        </defs>
        {/* rounded tile background */}
        <rect
          x="2"
          y="2"
          width="44"
          height="44"
          rx="13"
          fill={isMono ? '#ffffff' : `url(#${gradientId})`}
        />
        {/* rabbit-ear + motion mark, cut out of the tile */}
        <path
          d="M16 34V18.5c0-1.5 1.8-2.3 2.9-1.2l4.6 4.6c.5.5 1.3.5 1.8 0l5.6-5.6c1.1-1.1 2.9-.3 2.9 1.2V34"
          stroke={isMono ? '#0f172a' : '#ffffff'}
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* forward hop arc */}
        <path
          d="M14 38c4-2.5 9-2.5 13 0s9 2.5 13 0"
          stroke={isMono ? '#0f172a' : '#ffffff'}
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
          opacity="0.9"
        />
      </svg>
      {showWordmark && (
        <span
          className={`font-semibold text-[1.05rem] leading-none ${
            isMono ? 'text-white' : ''
          }`}
        >
          Hop<span className="text-hop-gradient">It</span>
        </span>
      )}
    </div>
  )
}
