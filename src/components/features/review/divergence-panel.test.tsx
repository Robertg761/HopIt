// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentDivergence } from '@/lib/client/agent-status'
import { DivergencePanel } from './divergence-panel'

function makeDivergence(overrides: Partial<AgentDivergence> = {}): AgentDivergence {
  return {
    path: 'README.md',
    scope: 'shared',
    reason: 'content_differs',
    entryId: 'entry-1',
    entryType: 'write',
    baseRevision: 3,
    cloudRevision: 5,
    localHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    cloudHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localDeviceName: 'MacBook',
    cloudDeviceName: 'Desktop',
    detectedAt: '2026-07-24T10:00:00.000Z',
    ageMs: 45_000,
    ...overrides,
  }
}

describe('DivergencePanel', () => {
  it('renders nothing when there are no open divergences', () => {
    const { container } = render(
      <DivergencePanel divergences={[]} onResolve={vi.fn()} resolvingPath={null} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders both device labels side by side for an open divergence', () => {
    render(
      <DivergencePanel divergences={[makeDivergence()]} onResolve={vi.fn()} resolvingPath={null} />,
    )

    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getAllByText('MacBook').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Desktop').length).toBeGreaterThan(0)
    expect(screen.getByText('Content differs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep MacBook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Desktop' })).toBeInTheDocument()
  })

  it('falls back to generic labels when device names are unknown', () => {
    render(
      <DivergencePanel
        divergences={[makeDivergence({ localDeviceName: null, cloudDeviceName: null })]}
        onResolve={vi.fn()}
        resolvingPath={null}
      />,
    )

    expect(screen.getByRole('button', { name: 'Keep This device' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Cloud' })).toBeInTheDocument()
  })

  it('calls onResolve with the path and "local" when the local side is kept', () => {
    const onResolve = vi.fn()
    render(
      <DivergencePanel divergences={[makeDivergence()]} onResolve={onResolve} resolvingPath={null} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Keep MacBook' }))
    expect(onResolve).toHaveBeenCalledWith('README.md', 'local')
  })

  it('calls onResolve with the path and "cloud" when the cloud side is kept', () => {
    const onResolve = vi.fn()
    render(
      <DivergencePanel divergences={[makeDivergence()]} onResolve={onResolve} resolvingPath={null} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Keep Desktop' }))
    expect(onResolve).toHaveBeenCalledWith('README.md', 'cloud')
  })

  it('disables the buttons for a divergence currently being resolved', () => {
    render(
      <DivergencePanel divergences={[makeDivergence()]} onResolve={vi.fn()} resolvingPath="README.md" />,
    )

    expect(screen.getByRole('button', { name: 'Keep MacBook' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep Desktop' })).toBeDisabled()
  })

  it('renders one row per open divergence', () => {
    render(
      <DivergencePanel
        divergences={[makeDivergence({ path: 'a.md' }), makeDivergence({ path: 'b.md' })]}
        onResolve={vi.fn()}
        resolvingPath={null}
      />,
    )

    expect(screen.getAllByTestId('divergence-row')).toHaveLength(2)
    expect(screen.getByText('a.md')).toBeInTheDocument()
    expect(screen.getByText('b.md')).toBeInTheDocument()
  })
})
