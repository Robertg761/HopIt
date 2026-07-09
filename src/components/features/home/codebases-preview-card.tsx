'use client'

import Link from 'next/link'
import { ArrowRight, Boxes } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { CodebaseSummary } from '@/components/workspace/workspace-provider'
import { formatCount } from '@/lib/client/format'

export function CodebasesPreviewCard({ codebases, loading }: { codebases: CodebaseSummary[]; loading: boolean }) {
  const preview = codebases.slice(0, 4)

  return (
    <Card className="overflow-hidden bg-[var(--signal)] text-[#17352e]">
      <CardHeader className="flex-row items-start justify-between pb-5">
        <div>
          <p className="mono-label mb-2 text-[#17352e]/60">Account / {formatCount(codebases.length)} total</p>
          <CardTitle className="font-display text-2xl font-normal tracking-[-0.03em] text-[#17352e]">Codebases in orbit</CardTitle>
        </div>
        <span className="grid size-10 place-items-center rounded-full bg-[#17352e] text-[var(--signal)]">
          <Boxes className="size-4" />
        </span>
      </CardHeader>
      <CardContent className="pt-1">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        ) : preview.length === 0 ? (
          <p className="py-5 text-sm text-[#17352e]/70">No codebases in this account yet.</p>
        ) : (
          <ul className="divide-y divide-[#17352e]/15 border-y border-[#17352e]/15">
            {preview.map((codebase, index) => (
              <li key={codebase.id}>
                <Link href="/codebases" className="group grid grid-cols-[1.5rem_1fr_auto] items-center gap-2 py-3 outline-none">
                  <span className="font-mono text-[0.58rem] text-[#17352e]/50">{String(index + 1).padStart(2, '0')}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{codebase.name}</p>
                    <p className="mt-0.5 text-[0.65rem] text-[#17352e]/65">{formatCount(codebase.fileCount)} files · {codebase.hydrationState}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="border-[#17352e]/20 bg-transparent text-[#17352e]" tone="outline">{codebase.attached ? 'Attached' : 'Cloud'}</Badge>
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Button asChild variant="ghost" className="mt-4 px-0 text-[#17352e] hover:bg-transparent">
          <Link href="/codebases">Manage all codebases <ArrowRight /></Link>
        </Button>
      </CardContent>
    </Card>
  )
}
