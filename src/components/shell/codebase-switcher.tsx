'use client'

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { BookMarked, Check, ChevronsUpDown } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { codebaseIdFromPath, repoPath, repoPathPreservingTab } from '@/components/shell/repo-nav'

export function CodebaseSwitcher() {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const { status, codebases, selectedCodebaseId, selectCodebase } = useWorkspace()

  const pathId = codebaseIdFromPath(pathname)
  const currentId = pathId ?? selectedCodebaseId ?? status.codebaseId
  const current = codebases.find((codebase) => codebase.id === currentId)
  const currentLabel = current?.name ?? status.codebaseName ?? currentId ?? 'No repository'

  function openCodebase(codebaseId: string) {
    selectCodebase(codebaseId)
    if (codebaseIdFromPath(pathname)) {
      router.push(repoPathPreservingTab(pathname, codebaseId))
    } else {
      router.push(repoPath(codebaseId))
    }
  }

  if (codebases.length === 0) {
    return (
      <span className="inline-flex h-8 max-w-52 items-center gap-2 truncate rounded-md border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground">
        <BookMarked className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{currentLabel}</span>
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-8 max-w-60 gap-1.5 px-2 font-medium">
          <BookMarked className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{currentLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Repositories</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {codebases.map((codebase) => (
          <DropdownMenuItem
            key={codebase.id}
            onSelect={() => openCodebase(codebase.id)}
            className="gap-2"
          >
            <span className="flex-1 truncate">{codebase.name}</span>
            {codebase.id === currentId ? <Check className="size-4 text-hop" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
