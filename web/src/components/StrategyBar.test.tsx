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
    sessionDates: [],
    evaluatedSessions: new Set<string>(),
    onCursorChange: vi.fn(),
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
        sessionDates={[]}
        evaluatedSessions={new Set()}
        onCursorChange={() => {}}
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
        sessionDates={[]}
        evaluatedSessions={new Set()}
        onCursorChange={() => {}}
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

  it('renders an em-dash and NO stepper buttons without a run (empty sessionDates)', () => {
    renderBar({ sessionCursor: null, sessionDates: [] })
    expect(screen.getByLabelText('session cursor')).toHaveTextContent('—')
    expect(screen.queryByLabelText('previous session')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('next session')).not.toBeInTheDocument()
  })

  const DATES = ['2026-05-13', '2026-05-14', '2026-05-15']

  it('shows a "no evaluation" marker when the cursor date was not evaluated', () => {
    renderBar({
      sessionCursor: '2026-05-14',
      sessionDates: DATES,
      evaluatedSessions: new Set(['2026-05-15']),
    })
    const readout = screen.getByLabelText('session cursor')
    expect(readout).toHaveTextContent('2026-05-14')
    expect(readout).toHaveTextContent('no evaluation')
  })

  it('shows an "evaluated" marker when the cursor date was evaluated', () => {
    renderBar({
      sessionCursor: '2026-05-15',
      sessionDates: DATES,
      evaluatedSessions: new Set(['2026-05-15']),
    })
    const readout = screen.getByLabelText('session cursor')
    expect(readout).toHaveTextContent('2026-05-15')
    expect(readout).toHaveTextContent('evaluated')
    expect(readout).not.toHaveTextContent('no evaluation')
  })

  it('steps to the adjacent SERVER date via ▶ / ◀', () => {
    const props = renderBar({ sessionCursor: '2026-05-14', sessionDates: DATES })
    fireEvent.click(screen.getByLabelText('next session'))
    expect(props.onCursorChange).toHaveBeenLastCalledWith('2026-05-15')
    fireEvent.click(screen.getByLabelText('previous session'))
    expect(props.onCursorChange).toHaveBeenLastCalledWith('2026-05-13')
  })

  it('disables ◀ at the first session and ▶ at the last session', () => {
    const { rerender } = render(
      <StrategyBar
        doc={newStrategyDocument('X')}
        dirty={false}
        saving={false}
        datasetId={undefined}
        datasetMeta={undefined}
        sessionCursor="2026-05-13"
        sessionDates={DATES}
        evaluatedSessions={new Set()}
        onCursorChange={() => {}}
        onValidate={vi.fn()}
        onRun={vi.fn()}
        onSave={vi.fn()}
        onChooseDataset={vi.fn()}
        onHome={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('previous session')).toBeDisabled()
    expect(screen.getByLabelText('next session')).not.toBeDisabled()
    rerender(
      <StrategyBar
        doc={newStrategyDocument('X')}
        dirty={false}
        saving={false}
        datasetId={undefined}
        datasetMeta={undefined}
        sessionCursor="2026-05-15"
        sessionDates={DATES}
        evaluatedSessions={new Set()}
        onCursorChange={() => {}}
        onValidate={vi.fn()}
        onRun={vi.fn()}
        onSave={vi.fn()}
        onChooseDataset={vi.fn()}
        onHome={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('previous session')).not.toBeDisabled()
    expect(screen.getByLabelText('next session')).toBeDisabled()
  })
})
