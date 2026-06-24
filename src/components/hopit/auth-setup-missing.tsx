import { HopItLogo } from '@/components/hopit/logo'

type AuthSetupMissingProps = {
  title?: string
}

export function AuthSetupMissing({ title = 'Authentication setup required' }: AuthSetupMissingProps) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-border/70 bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <HopItLogo size={32} />
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Clerk is selected as HopIt&apos;s product auth provider.</p>
          </div>
        </div>
        <div className="mt-5 rounded-lg bg-muted/35 p-3 text-sm text-muted-foreground ring-1 ring-border/60">
          Configure `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_JWT_ISSUER_DOMAIN` for this environment.
        </div>
      </section>
    </main>
  )
}
