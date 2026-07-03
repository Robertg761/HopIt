'use client'

import * as React from 'react'
import { Gavel } from 'lucide-react'

import type { ReviewDecision, ReviewDecisionKind } from '@/lib/collaboration'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { BACKEND_UNAVAILABLE_NOTE, QuietNote } from './review-shared'
import type { ReviewData } from './use-review-data'

const DECISION_TONES: Record<ReviewDecisionKind, BadgeTone> = {
  approved: 'hop',
  'changes-requested': 'danger',
  commented: 'neutral',
}

const DECISION_LABELS: Record<ReviewDecisionKind, string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  commented: 'Commented',
}

export function DecisionsCard({
  review,
  composerDisabledReason,
}: {
  review: ReviewData
  composerDisabledReason: string | null
}) {
  const [kind, setKind] = React.useState<ReviewDecisionKind>('commented')
  const [summary, setSummary] = React.useState('')

  async function submit() {
    const created = await review.submitDecision(kind, summary)
    if (created) setSummary('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
        <CardDescription>Recorded review outcomes for the active change set.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {review.decisionsUnavailable ? (
          <QuietNote>{BACKEND_UNAVAILABLE_NOTE}</QuietNote>
        ) : review.decisionsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : review.decisions.length === 0 ? (
          <QuietNote>No decisions recorded yet.</QuietNote>
        ) : (
          <ul className="space-y-1">
            {review.decisions.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))}
          </ul>
        )}
        {!review.decisionsUnavailable ? (
          <div className="border-t border-border pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Decision" htmlFor="review-decision-kind" className="w-44">
                <Select
                  id="review-decision-kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ReviewDecisionKind)}
                  disabled={composerDisabledReason !== null}
                >
                  <option value="approved">Approved</option>
                  <option value="changes-requested">Changes requested</option>
                  <option value="commented">Commented</option>
                </Select>
              </Field>
              <Field label="Summary (optional)" htmlFor="review-decision-summary" className="min-w-56 flex-1">
                <Input
                  id="review-decision-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit()
                  }}
                  placeholder="Looks good — ship it"
                  disabled={composerDisabledReason !== null}
                />
              </Field>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={composerDisabledReason !== null || review.submittingDecision}
              >
                {review.submittingDecision ? <Spinner className="size-3.5" /> : <Gavel />}
                Record decision
              </Button>
            </div>
            {composerDisabledReason ? <QuietNote>{composerDisabledReason}</QuietNote> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DecisionRow({ decision }: { decision: ReviewDecision }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-muted/50">
      <Badge tone={DECISION_TONES[decision.decision]}>{DECISION_LABELS[decision.decision]}</Badge>
      <span className="min-w-0 flex-1 truncate text-sm">
        {decision.summary ?? <span className="text-muted-foreground">No summary</span>}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{decision.createdBy}</span>
      <span
        className="text-xs text-muted-foreground"
        title={formatAbsoluteTime(decision.createdAt)}
      >
        {formatRelativeTime(decision.createdAt)}
      </span>
    </li>
  )
}
