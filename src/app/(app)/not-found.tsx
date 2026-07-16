import { SearchX } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'

export default function AppNotFound() {
  return (
    <div className="mx-auto flex min-h-[70dvh] w-full max-w-3xl items-center px-4 py-10 sm:px-6 lg:px-8">
      <Card className="w-full">
        <CardContent>
          <EmptyState
            icon={SearchX}
            title="Page not found"
            titleAs="h1"
            description="This HopIt page does not exist, or it is not available to your account."
            action={
              <Button asChild>
                <Link href="/overview">Back to dashboard</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    </div>
  )
}
