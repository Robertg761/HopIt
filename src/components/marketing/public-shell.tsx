import Link from 'next/link'

import { HopItLogo } from '@/components/brand/logo'
import { MobileNav } from '@/components/marketing/mobile-nav'
import { PublicAuthActions } from '@/components/marketing/public-auth-actions'
import { SkipLink } from '@/components/ui/skip-link'

export function PublicShell({ children, signedIn = false }: { children: React.ReactNode; signedIn?: boolean }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <SkipLink href="#page-main" />
      <header className="relative sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center gap-5 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <HopItLogo size={24} />
          </Link>
          <nav aria-label="Public" className="ml-auto hidden items-center gap-1 sm:flex">
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/#how-it-works">How it works</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/#pricing">Pricing</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/download">Download</Link>
            <Link className="rounded-md px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/privacy">Privacy</Link>
          </nav>
          <MobileNav />
          <PublicAuthActions signedIn={signedIn} />
        </div>
      </header>

      <main id="page-main">{children}</main>

      <footer className="border-t border-border bg-muted/25">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-9 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <HopItLogo size={20} />
          <p>Cloud workspaces with local control.</p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto">
            <Link className="rounded-sm underline decoration-border underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/download">Download</Link>
            <Link className="rounded-sm underline decoration-border underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/privacy">Privacy</Link>
            <Link className="rounded-sm underline decoration-border underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="/terms">Terms</Link>
            <a className="rounded-sm underline decoration-border underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" href="mailto:support@hopit.dev">Support</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
