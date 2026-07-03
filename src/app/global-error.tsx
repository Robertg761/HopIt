'use client'

import { AlertTriangle } from 'lucide-react'

import '@/styles/globals.css'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { humanizeApiError } from '@/lib/client/errors'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const description = humanizeApiError(error.message)

  return (
    <html lang="en">
      <body>
        <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
          <Card className="w-full max-w-lg">
            <CardContent>
              <EmptyState
                icon={AlertTriangle}
                title="HopIt needs a refresh"
                description={description}
                action={
                  <Button type="button" onClick={reset}>
                    Try again
                  </Button>
                }
              />
            </CardContent>
          </Card>
        </main>
      </body>
    </html>
  )
}
