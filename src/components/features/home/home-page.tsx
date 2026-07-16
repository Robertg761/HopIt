'use client'

import Link from 'next/link'
import { ArrowRight, Download } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { AccountSummary } from './account-summary'
import { CodebasesPreviewCard } from './codebases-preview-card'

export function HomePage() {
  const { codebases, codebasesLoading } = useWorkspace()

  return (
    <PageScaffold
      title="Dashboard"
      description="Your HopIt account at a glance."
    >
      <AccountSummary repositoryCount={codebases.length} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <CodebasesPreviewCard codebases={codebases} loading={codebasesLoading} />
        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-hop/10 text-hop">
              <Download className="size-4" aria-hidden />
            </div>
            <CardTitle as="h2" className="pt-2">HopIt on your devices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <p className="text-sm leading-6 text-muted-foreground">
              Install HopIt anywhere you work and your repositories will be ready when you need them.
            </p>
            <Button asChild variant="outline">
              <Link href="/download">
                View downloads
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageScaffold>
  )
}
