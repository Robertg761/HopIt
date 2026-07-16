// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Field } from './field'
import { Input } from './input'

describe('Field', () => {
  it('associates hints and errors with its control', () => {
    render(
      <Field label="Repository name" hint="Use the cloud project name." error="That name is unavailable.">
        <Input />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Repository name' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Use the cloud project name. That name is unavailable.')
    expect(screen.getByRole('alert')).toHaveTextContent('That name is unavailable.')
  })
})
