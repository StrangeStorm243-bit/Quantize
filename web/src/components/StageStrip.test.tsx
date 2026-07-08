import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StageStrip } from './StageStrip'

// The demo (ETF Momentum Rotation) node categories, in graph order.
const DEMO = [
  { id: 'u', category: 'universe' },
  { id: 'px', category: 'data' },
  { id: 'ret', category: 'transform' },
  { id: 'rk', category: 'selection' },
  { id: 'sel', category: 'selection' },
  { id: 'ew', category: 'weighting' },
  { id: 'cap', category: 'risk' },
  { id: 'tp', category: 'output' },
]

function segButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(label) })
}

describe('StageStrip', () => {
  it('renders the fixed six segments with the demo per-segment counts (including an empty stage)', () => {
    render(<StageStrip nodes={DEMO} />)
    expect(segButton('Data').textContent).toContain('2') // universe + data
    expect(segButton('Transforms').textContent).toContain('1')
    expect(segButton('Signals').textContent).toContain('0') // no signal node — still shown
    expect(segButton('Rank & Select').textContent).toContain('2') // rank + select_top_n
    expect(segButton('Weighting & Risk').textContent).toContain('2') // equal_weight + max_weight
    expect(segButton('Targets').textContent).toContain('1')
  })

  it('renders a distinct Engine segment that does NOT claim graph membership', () => {
    const { container } = render(<StageStrip nodes={DEMO} />)
    expect(screen.getByText('Engine')).toBeInTheDocument()
    // The engine is drawn outside the graph — its own styling hook, not a graph-segment button.
    expect(container.querySelector('.stage__seg--engine')).not.toBeNull()
  })

  it('rolls an unknown/reserved category into an appended Advanced bucket (never dropped)', () => {
    render(<StageStrip nodes={[...DEMO, { id: 'opt', category: 'optimization' }]} />)
    expect(segButton('Advanced').textContent).toContain('1')
  })

  it('omits the Advanced bucket when every node maps to a known segment', () => {
    render(<StageStrip nodes={DEMO} />)
    expect(screen.queryByRole('button', { name: /Advanced/ })).not.toBeInTheDocument()
  })

  it('excludes component instances from segment counts and shows them as a Components chip', () => {
    render(<StageStrip nodes={[...DEMO, { id: 'c1', isComponent: true }]} />)
    // The component does not inflate any stage; it gets its own chip.
    expect(segButton('Targets').textContent).toContain('1')
    expect(screen.getByText(/Components/)).toBeInTheDocument()
  })

  it('calls onSelectSegment with the segment node ids when a segment is clicked', () => {
    const onSelectSegment = vi.fn()
    render(<StageStrip nodes={DEMO} onSelectSegment={onSelectSegment} />)
    fireEvent.click(segButton('Rank & Select'))
    expect(onSelectSegment).toHaveBeenCalledWith(['rk', 'sel'])
  })
})
