import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { QuickAdd } from './QuickAdd'

const catalog = catalogJson as unknown as NodeCatalogResponse

describe('QuickAdd', () => {
  it('fuzzy-filters the catalog by display name', () => {
    render(<QuickAdd catalog={catalog} onAdd={vi.fn()} onClose={vi.fn()} />)
    // Everything shows before typing.
    expect(screen.getByText('Rank')).toBeInTheDocument()
    expect(screen.getByText('Fixed Universe')).toBeInTheDocument()
    // Typing narrows to a fuzzy (subsequence) match.
    fireEvent.change(screen.getByLabelText('quick add search'), { target: { value: 'rank' } })
    expect(screen.getByText('Rank')).toBeInTheDocument()
    expect(screen.queryByText('Fixed Universe')).not.toBeInTheDocument()
  })

  it('shows a no-matches state for a query that hits nothing', () => {
    render(<QuickAdd catalog={catalog} onAdd={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('quick add search'), { target: { value: 'zzzzzz' } })
    expect(screen.getByText(/No matching node/)).toBeInTheDocument()
  })

  it('calls onAdd with the chosen node type', () => {
    const onAdd = vi.fn<(nt: NodeTypeDto) => void>()
    render(<QuickAdd catalog={catalog} onAdd={onAdd} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('quick add search'), { target: { value: 'rank' } })
    fireEvent.click(screen.getByText('Rank'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0].type_id).toBe('transform.rank')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<QuickAdd catalog={catalog} onAdd={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('quick add search'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Enter adds the first match when no arrow keys are pressed', () => {
    const onAdd = vi.fn<(nt: NodeTypeDto) => void>()
    render(<QuickAdd catalog={catalog} onAdd={onAdd} onClose={vi.fn()} />)
    // Sorted by display name; the first match is "Apply Mask".
    fireEvent.keyDown(screen.getByLabelText('quick add search'), { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0].display_name).toBe('Apply Mask')
  })

  it('ArrowDown moves the active row and Enter adds it; ArrowUp moves back', () => {
    const onAdd = vi.fn<(nt: NodeTypeDto) => void>()
    render(<QuickAdd catalog={catalog} onAdd={onAdd} onClose={vi.fn()} />)
    const input = screen.getByLabelText('quick add search')
    // Sorted: Apply Mask, Equal Weight, Fixed Universe, ...
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0].display_name).toBe('Fixed Universe')
    // ArrowUp steps back to the second match.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(2)
    expect(onAdd.mock.calls[1][0].display_name).toBe('Equal Weight')
  })

  it('visually marks the active row', () => {
    render(<QuickAdd catalog={catalog} onAdd={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByLabelText('quick add search')
    // First match is active by default.
    expect(screen.getByText('Apply Mask').closest('button')).toHaveClass('quickadd__item--active')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByText('Apply Mask').closest('button')).not.toHaveClass('quickadd__item--active')
    expect(screen.getByText('Equal Weight').closest('button')).toHaveClass('quickadd__item--active')
  })

  it('resets the active row to the first match when the query changes', () => {
    const onAdd = vi.fn<(nt: NodeTypeDto) => void>()
    render(<QuickAdd catalog={catalog} onAdd={onAdd} onClose={vi.fn()} />)
    const input = screen.getByLabelText('quick add search')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // Narrowing the list resets the highlight to the top match.
    fireEvent.change(input, { target: { value: 'weight' } })
    // Matches (sorted): Equal Weight, Fixed Weight, Max Weight Cap — first is active.
    expect(screen.getByText('Equal Weight').closest('button')).toHaveClass('quickadd__item--active')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0].display_name).toBe('Equal Weight')
  })

  it('Enter with zero matches does nothing', () => {
    const onAdd = vi.fn<(nt: NodeTypeDto) => void>()
    render(<QuickAdd catalog={catalog} onAdd={onAdd} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('quick add search'), { target: { value: 'zzzzzz' } })
    fireEvent.keyDown(screen.getByLabelText('quick add search'), { key: 'Enter' })
    expect(onAdd).not.toHaveBeenCalled()
  })
})
