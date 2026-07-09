import { HopItLogo } from '@/components/brand/logo'

export function AuthSetupMissing({ title = 'Authentication setup required' }: { title?: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-lg rounded-[1.75rem] border border-border bg-card p-7 shadow-[0_24px_70px_rgba(23,53,46,0.1)]">
        <div className="flex items-center gap-3">
          <HopItLogo size={32} showWordmark={false} />
          <div>
            <h1 className="font-display text-2xl tracking-[-0.03em]">{title}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Clerk is selected as HopIt&apos;s product auth provider.
            </p>
          </div>
        </div>
        <p className="mt-6 rounded-2xl border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed text-muted-foreground">
          Configure NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and CLERK_JWT_ISSUER_DOMAIN
          for this environment.
        </p>
      </section>
    </main>
  )
}
