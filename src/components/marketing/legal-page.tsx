export function LegalPage({
  title,
  summary,
  updated,
  children,
}: {
  title: string
  summary: string
  updated: string
  children: React.ReactNode
}) {
  return (
    <article className="mx-auto w-full max-w-[860px] px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
      <header className="border-b border-border pb-10">
        <h1 className="text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">{title}</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">{summary}</p>
        <p className="mt-6 text-xs text-muted-foreground">Effective and last updated {updated}</p>
      </header>
      <div className="legal-copy py-10 text-[15px] leading-7 text-muted-foreground [&_a]:font-medium [&_a]:text-iris [&_a]:underline-offset-4 hover:[&_a]:underline [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground [&_li]:pl-1 [&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {children}
      </div>
    </article>
  )
}
