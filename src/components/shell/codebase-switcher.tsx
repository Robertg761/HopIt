'use client'

import * as React from 'react'
import { Boxes, Check, ChevronsUpDown } from 'lucide-react'

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

export function CodebaseSwitcher() {
  const { status, codebases, selectedCodebaseId, selectCodebase } = useWorkspace()

  const currentId = selectedCodebaseId ?? status.codebaseId
  const current = codebases.find((codebase) => codebase.id === currentId)
  const currentLabel = current?.name ?? status.codebaseName ?? currentId ?? 'No codebase'

  if (codebases.length === 0) {
    return (
      <span className="inline-flex h-9 max-w-52 items-center gap-2 truncate rounded-full border border-border bg-card/70 px-3 text-sm text-muted-foreground">
        <Boxes className="size-4 shrink-0 text-hop" />
        <span className="truncate font-semibold">{currentLabel}</span>
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-10 max-w-60 gap-2 rounded-full border border-transparent px-2.5 font-semibold hover:border-border hover:bg-card/70">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-hop-soft text-hop-soft-foreground">
            <Boxes className="size-3.5" />
          </span>
          <span className="hidden text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted-foreground md:inline">Codebase</span>
          <span className="truncate">{currentLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Codebases</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {codebases.map((codebase) => (
          <DropdownMenuItem
            key={codebase.id}
            onSelect={() => selectCodebase(codebase.id)}
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
