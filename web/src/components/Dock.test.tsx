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
    render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />)
    for (const label of ['Problems', 'Runs', 'Results', 'Trace']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByText('problems-body')).toBeInTheDocument()
    expect(screen.queryByText('runs-body')).not.toBeInTheDocument()
  })

  it('marks the active tab pressed and switches content by prop', () => {
    const { rerender } = render(
      <Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Problems' })).toHaveAttribute('aria-pressed', 'true')
    rerender(<Dock tab="runs" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />)
    expect(screen.getByText('runs-body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onTab when a tab is clicked', () => {
    const onTab = vi.fn()
    render(<Dock tab="problems" onTab={onTab} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(onTab).toHaveBeenCalledWith('runs')
  })

  it('disables a panel tab that is not yet available (results/trace before a run)', () => {
    render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Results' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Trace' })).toBeDisabled()
  })

  // --- Collapse control (M14.4) -----------------------------------------------------------------

  it('renders the collapse chevron with aria-expanded reflecting the collapsed state', () => {
    const { rerender } = render(
      <Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={vi.fn()} />,
    )
    // Open → the panel is showing: the chevron reports expanded and offers the COLLAPSE action.
    expect(screen.getByRole('button', { name: 'collapse dock' })).toHaveAttribute('aria-expanded', 'true')
    rerender(<Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed onToggleCollapse={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'expand dock' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('calls onToggleCollapse when the chevron is clicked', () => {
    const onToggleCollapse = vi.fn()
    render(
      <Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed={false} onToggleCollapse={onToggleCollapse} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'collapse dock' }))
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('renders the tab strip but NOT the active panel content when collapsed', () => {
    render(<Dock tab="problems" onTab={vi.fn()} panels={panels()} collapsed onToggleCollapse={vi.fn()} />)
    // Tabs stay clickable so the dock can re-expand on one.
    expect(screen.getByRole('button', { name: 'Problems' })).toBeInTheDocument()
    // The active panel is unmounted — its body is gone.
    expect(screen.queryByText('problems-body')).not.toBeInTheDocument()
  })

  it('a tab click while collapsed fires BOTH onTab and onToggleCollapse (re-expand on that tab)', () => {
    const onTab = vi.fn()
    const onToggleCollapse = vi.fn()
    render(
      <Dock tab="problems" onTab={onTab} panels={panels()} collapsed onToggleCollapse={onToggleCollapse} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(onTab).toHaveBeenCalledWith('runs')
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('a tab click while EXPANDED fires only onTab (no spurious collapse toggle)', () => {
    const onTab = vi.fn()
    const onToggleCollapse = vi.fn()
    render(
      <Dock tab="problems" onTab={onTab} panels={panels()} collapsed={false} onToggleCollapse={onToggleCollapse} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(onTab).toHaveBeenCalledWith('runs')
    expect(onToggleCollapse).not.toHaveBeenCalled()
  })
})
