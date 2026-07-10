import { HopItLogo } from '@/components/brand/logo'

export function AuthSetupMissing({ title = 'Authentication setup required' }: { title?: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-lg rounded-md border border-border bg-card p-6">
        <div className="flex items-center gap-3">
          <HopItLogo size={28} showWordmark={false} />
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Clerk is selected as HopIt&apos;s product auth provider.
            </p>
          </div>
        </div>
        <p className="mt-5 rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          Configure NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and CLERK_JWT_ISSUER_DOMAIN
          for this environment.
        </p>
      </section>
    </main>
  )
}
