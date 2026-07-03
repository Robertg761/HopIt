import type { BadgeTone } from '@/components/ui/badge'
import type { AgentFileLocalState } from '@/lib/client/agent-status'

export const LOCAL_STATE_TONES: Record<AgentFileLocalState, BadgeTone> = {
  hydrated: 'hop',
  uploaded: 'hop',
  'cloud-only': 'outline',
  dirty: 'amber',
  'pending-upload': 'amber',
  pinned: 'iris',
  blocked: 'danger',
  prunable: 'neutral',
}

export function localStateLabel(state: AgentFileLocalState): string {
  return state.replace(/-/g, ' ')
}
