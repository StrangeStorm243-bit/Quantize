import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentTrailEntry } from '../document/flow'
import { Breadcrumb } from './Breadcrumb'

const oneLevel: ComponentTrailEntry[] = [{ componentId: 'mom', version: '1.0.0' }]
const twoLevel: ComponentTrailEntry[] = [
  { componentId: 'mom', version: '1.0.0' },
  { componentId: 'rank', version: '2.1.0' },
]

describe('Breadcrumb', () => {
  it('renders a labelled component-breadcrumb nav', () => {
    render(<Breadcrumb strategyName="Alpha" trail={oneLevel} labels={['Momentum']} onNavigate={vi.fn()} />)
    expect(screen.getByRole('navigation', { name: 'component breadcrumb' })).toBeInTheDocument()
  })

  it('renders the root crumb as a button showing the strategy name, → onNavigate(0)', () => {
    const onNavigate = vi.fn()
    render(<Breadcrumb strategyName="Alpha" trail={oneLevel} labels={['Momentum']} onNavigate={onNavigate} />)
    const root = screen.getByRole('button', { name: 'Alpha' })
    fireEvent.click(root)
    expect(onNavigate).toHaveBeenCalledWith(0)
  })

  it('falls back to the literal "Strategy" when the name is empty', () => {
    render(<Breadcrumb strategyName="" trail={oneLevel} labels={['Momentum']} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Strategy' })).toBeInTheDocument()
  })

  it('renders each trail crumb as `Name vX.Y.Z`', () => {
    render(<Breadcrumb strategyName="Alpha" trail={oneLevel} labels={['Momentum']} onNavigate={vi.fn()} />)
    expect(screen.getByText('Momentum v1.0.0')).toBeInTheDocument()
  })

  it('falls back to the componentId when a label is not yet loaded', () => {
    render(<Breadcrumb strategyName="Alpha" trail={oneLevel} labels={[undefined]} onNavigate={vi.fn()} />)
    expect(screen.getByText('mom v1.0.0')).toBeInTheDocument()
  })

  it('navigates to depth i+1 when an intermediate crumb is clicked', () => {
    const onNavigate = vi.fn()
    render(
      <Breadcrumb
        strategyName="Alpha"
        trail={twoLevel}
        labels={['Momentum', 'Rank']}
        onNavigate={onNavigate}
      />,
    )
    // The first trail crumb (index 0) is intermediate here → onNavigate(1).
    fireEvent.click(screen.getByRole('button', { name: 'Momentum v1.0.0' }))
    expect(onNavigate).toHaveBeenCalledWith(1)
  })

  it('renders the last crumb non-interactively as the current page', () => {
    render(
      <Breadcrumb
        strategyName="Alpha"
        trail={twoLevel}
        labels={['Momentum', 'Rank']}
        onNavigate={vi.fn()}
      />,
    )
    const current = screen.getByText('Rank v2.1.0')
    expect(current.tagName).toBe('SPAN')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: 'Rank v2.1.0' })).not.toBeInTheDocument()
  })

  it('marks the separators aria-hidden', () => {
    const { container } = render(
      <Breadcrumb
        strategyName="Alpha"
        trail={twoLevel}
        labels={['Momentum', 'Rank']}
        onNavigate={vi.fn()}
      />,
    )
    // Two crumbs after the root → two separators, all presentational.
    const separators = container.querySelectorAll('[aria-hidden="true"]')
    expect(separators).toHaveLength(2)
    for (const sep of separators) {
      expect(sep.textContent).toBe('▸')
    }
  })
})
