// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

function ExampleTabs() {
  return (
    <Tabs defaultValue="one">
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
        <TabsTrigger value="three">Three</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First panel</TabsContent>
      <TabsContent value="two">Second panel</TabsContent>
      <TabsContent value="three">Third panel</TabsContent>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('uses roving focus and activates with arrow, Home, and End keys', async () => {
    const user = userEvent.setup()
    render(<ExampleTabs />)
    const tabs = screen.getAllByRole('tab')

    tabs[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(tabs[1]).toHaveFocus()
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Second panel')

    await user.keyboard('{End}')
    expect(tabs[2]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(tabs[0]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tabs[0]).toHaveFocus()
  })
})
