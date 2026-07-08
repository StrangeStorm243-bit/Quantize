import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DatasetStored } from '@quantize/quantize-api'
import { DataSourceCard } from './DataSourceCard'

// The Data Source card is the machine's most legible entry point. It is PURE presentation: every fact
// is either served dataset metadata or a document param passed in — the card computes nothing
// (invariant 5). These tests pin each state: bound, no-dataset, no-universe, and the read-only
// component view where the binding is not resolvable.

const META: DatasetStored = {
  dataset_id: 'sha256:abcdef0123456789abcdef',
  dataset_fingerprint: 'fp-abcdef0123456789',
  calendar_fingerprint: 'cal-1234',
  first_session: '2025-01-02',
  last_session: '2025-08-29',
  sessions: 168,
  assets: 6,
  asset_tickers: ['EFA', 'GLD', 'IWM', 'QQQ', 'SPY', 'TLT'],
}

describe('DataSourceCard', () => {
  it('shows source kind, date range, sessions, fingerprint and the connected universe when bound', () => {
    render(
      <DataSourceCard
        displayName="Price"
        datasetId={META.dataset_id}
        datasetMeta={META}
        universeTickers={['SPY', 'QQQ']}
      />,
    )
    expect(screen.getByText('Price')).toBeInTheDocument()
    expect(screen.getByText('Uploaded dataset')).toBeInTheDocument()
    // Date range + calendar bounds come verbatim from served metadata.
    expect(screen.getByText(/2025-01-02/)).toBeInTheDocument()
    expect(screen.getByText(/2025-08-29/)).toBeInTheDocument()
    expect(screen.getByText(/168/)).toBeInTheDocument()
    // Universe tickers come from the connected universe node's params (document data).
    expect(screen.getByText(/SPY/)).toBeInTheDocument()
    expect(screen.getByText(/QQQ/)).toBeInTheDocument()
    // Provenance: the content-addressed fingerprint (abbreviated).
    expect(screen.getByText(/fp-abcde/)).toBeInTheDocument()
    // The future connector kinds are named (reserved), so the product reads as a trading-bot IDE.
    expect(screen.getByText(/Data API · Broker feed — future/)).toBeInTheDocument()
  })

  it('shows an explicit unbound state when no dataset is selected', () => {
    render(<DataSourceCard displayName="Price" universeTickers={['SPY']} />)
    expect(
      screen.getByText('No dataset selected — choose in the strategy bar'),
    ).toBeInTheDocument()
    // No invented date range / fingerprint when unbound.
    expect(screen.queryByText(/2025-/)).not.toBeInTheDocument()
  })

  it('shows an explicit no-universe placeholder when nothing feeds the asset input', () => {
    render(<DataSourceCard displayName="Price" datasetId={META.dataset_id} datasetMeta={META} universeTickers={null} />)
    expect(screen.getByText('No universe connected')).toBeInTheDocument()
  })

  it('shows strategy-level placeholders inside a read-only component view (not resolvable here)', () => {
    render(<DataSourceCard displayName="Price" resolvable={false} />)
    // Both the dataset binding and the universe are resolved at the strategy level, not here.
    expect(screen.getAllByText('Bound at the strategy level').length).toBeGreaterThanOrEqual(1)
    // It must NOT claim the strategy has no dataset — it simply can't be resolved in this view.
    expect(
      screen.queryByText('No dataset selected — choose in the strategy bar'),
    ).not.toBeInTheDocument()
  })

  it('renders a validity badge reflecting the served diagnostics', () => {
    const { container } = render(
      <DataSourceCard displayName="Price" datasetId={META.dataset_id} datasetMeta={META} universeTickers={['SPY']} validity="error" />,
    )
    expect(container.querySelector('.snode__badge--error')).not.toBeNull()
  })
})
