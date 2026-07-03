'use client'

import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { humanizeApiError } from '@/lib/client/errors'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto flex min-h-[70dvh] w-full max-w-3xl items-center px-4 py-10 sm:px-6 lg:px-8">
      <Card className="w-full">
        <CardContent>
          <EmptyState
            icon={AlertTriangle}
            title="This page hit a snag"
            description={humanizeApiError(error.message)}
            action={
              <Button type="button" onClick={reset}>
                Try again
              </Button>
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
