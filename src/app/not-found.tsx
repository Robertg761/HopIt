import { SearchX } from 'lucide-react'
import Link from 'next/link'

import { PublicShell } from '@/components/marketing/public-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'

export default function NotFound() {
  return (
    <PublicShell>
      <div className="mx-auto flex min-h-[70dvh] w-full max-w-3xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <Card className="w-full">
          <CardContent>
            <EmptyState
              icon={SearchX}
              title="Page not found"
              titleAs="h1"
              description="That address does not point to a HopIt page. It may have moved, or the link may be incomplete."
              action={
                <Button asChild>
                  <Link href="/">Back to HopIt</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  )
}
