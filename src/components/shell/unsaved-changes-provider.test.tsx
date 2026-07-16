// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  UnsavedChangesProvider,
  useUnsavedChanges,
  useUnsavedChangesBlocker,
} from './unsaved-changes-provider'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

function Harness({ active, action }: { active: boolean; action: () => void }) {
  const { confirmOrRun } = useUnsavedChanges()
  useUnsavedChangesBlocker(active, 'Unsaved changes to src/app.ts will be lost.')
  return <button type="button" onClick={() => confirmOrRun(action)}>Navigate</button>
}

describe('UnsavedChangesProvider', () => {
  it('runs immediately without a blocker and asks before discarding active edits', async () => {
    const user = userEvent.setup()
    const action = vi.fn()
    const { rerender } = render(
      <UnsavedChangesProvider><Harness active={false} action={action} /></UnsavedChangesProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(action).toHaveBeenCalledTimes(1)

    rerender(<UnsavedChangesProvider><Harness active action={action} /></UnsavedChangesProvider>)
    await user.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
    expect(action).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(action).toHaveBeenCalledTimes(2)
  })
})
