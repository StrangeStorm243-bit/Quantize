import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DatasetStored } from '@quantize/quantize-api'
import { newStrategyDocument } from '../document/store'
import { StrategyBar } from './StrategyBar'

const META: DatasetStored = {
  dataset_id: 'd'.repeat(64),
  dataset_fingerprint: 'f'.repeat(64),
  calendar_fingerprint: 'c'.repeat(64),
  sessions: 21,
  assets: 3,
  first_session: '2026-01-05',
  last_session: '2026-02-04',
  asset_tickers: ['AAA', 'BBB', 'CCC'],
}

function renderBar(overrides: Partial<React.ComponentProps<typeof StrategyBar>> = {}) {
  const props = {
    doc: newStrategyDocument('ETF Momentum Rotation'),
    dirty: false,
    saving: false,
    datasetId: undefined,
    datasetMeta: undefined,
    sessionCursor: null,
    onValidate: vi.fn(),
    onRun: vi.fn(),
    onSave: vi.fn(),
    onChooseDataset: vi.fn(),
    onHome: vi.fn(),
    ...overrides,
  }
  render(<StrategyBar {...props} />)
  return props
}

describe('StrategyBar', () => {
  it('shows the document name and version', () => {
    renderBar()
    expect(screen.getByText('ETF Momentum Rotation')).toBeInTheDocument()
    expect(screen.getByText('v1')).toBeInTheDocument()
  })

  it('shows a dirty indicator only when dirty', () => {
    const { rerender } = render(
      <StrategyBar
        doc={newStrategyDocument('X')}
        dirty={false}
        saving={false}
        datasetId={undefined}
        datasetMeta={undefined}
        sessionCursor={null}
        onValidate={vi.fn()}
        onRun={vi.fn()}
        onSave={vi.fn()}
        onChooseDataset={vi.fn()}
        onHome={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument()
    rerender(
      <StrategyBar
        doc={newStrategyDocument('X')}
        dirty
        saving={false}
        datasetId={undefined}
        datasetMeta={undefined}
        sessionCursor={null}
        onValidate={vi.fn()}
        onRun={vi.fn()}
        onSave={vi.fn()}
        onChooseDataset={vi.fn()}
        onHome={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('unsaved changes')).toBeInTheDocument()
  })

  it('wires the Validate / Run / Save verbs', () => {
    const props = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onValidate).toHaveBeenCalledTimes(1)
    expect(props.onRun).toHaveBeenCalledTimes(1)
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })

  it('disables Save while saving', () => {
    renderBar({ saving: true })
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  })

  it('shows the unbound dataset state and opens the picker on click', () => {
    const props = renderBar({ datasetId: undefined })
    const chip = screen.getByRole('button', { name: 'active dataset' })
    expect(chip).toHaveTextContent(/none — choose/)
    fireEvent.click(chip)
    expect(props.onChooseDataset).toHaveBeenCalledTimes(1)
  })

  it('shows the active dataset with its date range from introspection metadata', () => {
    renderBar({ datasetId: META.dataset_id, datasetMeta: META })
    const chip = screen.getByRole('button', { name: 'active dataset' })
    expect(chip).toHaveTextContent('2026-01-05 → 2026-02-04')
  })

  it('renders an empty session-cursor slot until a cursor is set', () => {
    renderBar({ sessionCursor: null })
    expect(screen.getByLabelText('session cursor')).toHaveTextContent('—')
  })
})
