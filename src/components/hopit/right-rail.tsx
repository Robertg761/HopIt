'use client'

import { motion } from 'framer-motion'
import {
  MapPin,
  MousePointer2,
} from 'lucide-react'
import { collaborators } from './data'
import { cn } from '@/lib/utils'

export function RightRail() {
  return (
    <aside className="flex flex-col gap-4">
      <LiveCollaborators />
    </aside>
  )
}

function LiveCollaborators() {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Live now</h2>
          <span className="flex items-center gap-1 rounded-full bg-hop/10 px-1.5 py-0.5 text-[10px] font-medium text-hop">
            <span className="size-1.5 rounded-full bg-hop live-pulse" />
            {collaborators.length} online
          </span>
        </div>
        <button className="text-[11px] text-muted-foreground hover:text-foreground">
          See all
        </button>
      </div>

      <ul className="divide-y divide-border/50">
        {collaborators.map((c, i) => (
          <motion.li
            key={c.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.3 }}
            className="flex items-center gap-3 px-4 py-2.5"
          >
            <div className="relative">
              <div
                className="flex size-9 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ backgroundColor: c.color }}
              >
                {c.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')}
              </div>
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card',
                  c.status === 'active' && 'bg-hop live-pulse',
                  c.status === 'viewing' && 'bg-amber-400',
                  c.status === 'idle' && 'bg-muted-foreground/50',
                )}
                title={c.status}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{c.name}</p>
              <p className="flex items-center gap-1 truncate text-[10.5px] text-muted-foreground">
                <MapPin className="size-2.5 shrink-0" />
                {c.location}
              </p>
            </div>
            {c.cursor && (
              <span className="flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                <MousePointer2 className="size-2.5" style={{ color: c.color }} />
                {c.cursor.label}
              </span>
            )}
          </motion.li>
        ))}
      </ul>

      <div className="border-t border-border/60 p-3">
        <div className="rounded-lg bg-hop-gradient-soft p-3">
          <p className="text-[11px] font-medium text-foreground/80">
            3 people are editing the same file
          </p>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">
            Live cursors and selection sharing enabled
          </p>
        </div>
      </div>
    </section>
  )
}
