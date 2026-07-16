import { ArrowRight } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { signedInHomePath } from '@/lib/auth-config'

export function DownloadDashboardButton({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <Button asChild variant="outline" className="mt-6">
      <Link href={signedIn ? signedInHomePath : '/sign-in'}>
        Open the web dashboard <ArrowRight aria-hidden />
      </Link>
    </Button>
  )
}
