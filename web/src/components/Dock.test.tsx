import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import type { DockPanel } from './Dock'

function panels(): DockPanel[] {
  return [
    { id: 'problems', label: 'Problems', node: <div>problems-body</div> },
    { id: 'runs', label: 'Runs', node: <div>runs-body</div> },
    { id: 'results', label: 'Results', disabled: true, node: <div>results-body</div> },
    { id: 'trace', label: 'Trace', disabled: true, node: <div>trace-body</div> },
  ]
}

describe('Dock', () => {
  it('renders a tab per panel and mounts only the active panel', () => {
    render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} />)
    for (const label of ['Problems', 'Runs', 'Results', 'Trace']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByText('problems-body')).toBeInTheDocument()
    expect(screen.queryByText('runs-body')).not.toBeInTheDocument()
  })

  it('marks the active tab pressed and switches content by prop', () => {
    const { rerender } = render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} />)
    expect(screen.getByRole('button', { name: 'Problems' })).toHaveAttribute('aria-pressed', 'true')
    rerender(<Dock tab="runs" onTab={vi.fn()} panels={panels()} />)
    expect(screen.getByText('runs-body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onTab when a tab is clicked', () => {
    const onTab = vi.fn()
    render(<Dock tab="problems" onTab={onTab} panels={panels()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(onTab).toHaveBeenCalledWith('runs')
  })

  it('disables a panel tab that is not yet available (results/trace before a run)', () => {
    render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} />)
    expect(screen.getByRole('button', { name: 'Results' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Trace' })).toBeDisabled()
  })
})
