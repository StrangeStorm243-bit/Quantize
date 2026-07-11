import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JOURNEY_STEPS, type JourneyState } from '../journey/progress'
import { JourneyChecklist } from './JourneyChecklist'

const NONE: JourneyState = { done: [], dismissed: false }

describe('JourneyChecklist', () => {
  it('renders the five step labels in README §4 order', () => {
    render(<JourneyChecklist state={NONE} onDismiss={vi.fn()} />)
    const rendered = screen
      .getAllByTestId('journey-step-label')
      .map((el) => el.textContent)
    expect(rendered).toEqual(JOURNEY_STEPS.map((s) => s.label))
  })

  it('marks done steps and leaves the rest unmarked', () => {
    const state: JourneyState = { done: ['open-demo', 'run-backtest'], dismissed: false }
    render(<JourneyChecklist state={state} onDismiss={vi.fn()} />)
    const item = (label: string) => screen.getByText(label).closest('li')
    expect(item('Open the demo strategy')).toHaveAttribute('data-done', 'true')
    expect(item('Run a backtest')).toHaveAttribute('data-done', 'true')
    expect(item('Open Results')).toHaveAttribute('data-done', 'false')
    expect(item('Extract a component')).toHaveAttribute('data-done', 'false')
  })

  it('calls onDismiss when Dismiss is clicked', () => {
    const onDismiss = vi.fn()
    render(<JourneyChecklist state={NONE} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when dismissed', () => {
    const { container } = render(
      <JourneyChecklist state={{ done: [], dismissed: true }} onDismiss={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
