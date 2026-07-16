import { cn } from '@/lib/utils'

export function SkipLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      className={cn(
        'sr-only fixed left-3 top-3 z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-lg outline-none focus:not-sr-only focus:ring-2 focus:ring-ring focus:ring-offset-2',
        className,
      )}
    >
      Skip to content
    </a>
  )
}
