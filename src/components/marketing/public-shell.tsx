import Link from 'next/link'

import { HopItLogo } from '@/components/brand/logo'
import { PublicAuthActions } from '@/components/marketing/public-auth-actions'

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center gap-5 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <HopItLogo size={24} />
          </Link>
          <nav aria-label="Public" className="ml-auto hidden items-center gap-1 sm:flex">
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" href="/#how-it-works">How it works</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" href="/#pricing">Pricing</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" href="/download">Download</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" href="/privacy">Privacy</Link>
          </nav>
          <PublicAuthActions />
        </div>
      </header>

      <main>{children}</main>

      <footer className="border-t border-border bg-muted/25">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-9 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <HopItLogo size={20} />
          <p>Cloud workspaces with local control.</p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto">
            <Link className="hover:text-foreground" href="/download">Download</Link>
            <Link className="hover:text-foreground" href="/privacy">Privacy</Link>
            <Link className="hover:text-foreground" href="/terms">Terms</Link>
            <a className="hover:text-foreground" href="mailto:support@hopit.dev">Support</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
