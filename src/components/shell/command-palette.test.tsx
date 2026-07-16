// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CommandPalette } from './command-palette'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/shell/unsaved-changes-provider', () => ({
  useUnsavedChanges: () => ({ confirmOrRun: (action: () => void) => action() }),
}))
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/components/workspace/workspace-provider', () => ({
  useWorkspace: () => ({
    status: { codebaseId: null, commandsAvailable: false },
    selectedCodebaseId: null,
    runCommand: vi.fn(),
  }),
}))

describe('CommandPalette', () => {
  it('announces the active option while navigating with arrow keys', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<CommandPalette open onOpenChange={onOpenChange} />)

    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-activedescendant')
    const firstId = input.getAttribute('aria-activedescendant')

    await user.keyboard('{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).not.toBe(firstId)
    expect(document.getElementById(input.getAttribute('aria-activedescendant') ?? '')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
