// App open flow (M13.3): opening a strategy from Home is async (version lookup + load). Home stays
// interactive during those awaits, so a late load MUST NOT clobber a document the user created/opened
// in the meantime — the App applies the load through the store's compare-and-swap (replaceIf). NO
// network — the api client is mocked with a deferred load so we can interleave a mid-flight New.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from './document/store'

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual,
    getMeta: vi
      .fn()
      .mockResolvedValue({ api_version: 'v1', schema_version: '0.1.0', record_format: 1, trace_format: 1 }),
    getNodeCatalog: vi.fn().mockResolvedValue({
      api_version: 'v1',
      schema_version: '0.1.0',
      catalog_digest: '0'.repeat(64),
      port_types: [],
      compatibility: [],
      node_types: [],
    }),
    listStrategies: vi.fn().mockResolvedValue({ strategies: [] }),
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    getRun: vi.fn(),
    listStrategyVersions: vi.fn(),
    loadStrategyVersion: vi.fn(),
  }
})

// Home stub exposing New + two Open buttons so tests can interleave opens and a mid-flight New.
vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void; onOpen: (id: string) => void }) => (
    <div>
      <button type="button" onClick={() => props.onNew('Fresh')}>
        home-new
      </button>
      <button type="button" onClick={() => props.onOpen('s1')}>
        home-open
      </button>
      <button type="button" onClick={() => props.onOpen('s2')}>
        home-open-b
      </button>
    </div>
  ),
}))
vi.mock('./components/Canvas', () => ({ Canvas: () => <div /> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div /> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div /> }))

// eslint-disable-next-line import/first
import { App } from './App'
// eslint-disable-next-line import/first
import { listStrategyVersions, loadStrategyVersion } from './api/client'

const mockVersions = vi.mocked(listStrategyVersions)
const mockLoad = vi.mocked(loadStrategyVersion)

afterEach(() => vi.clearAllMocks())

describe('App open flow (M13.3)', () => {
  it('a mid-flight New supersedes an in-flight open (last action wins, silently)', async () => {
    mockVersions.mockResolvedValue({ versions: [1] })
    let resolveLoad: (doc: StrategyDocument) => void = () => {}
    mockLoad.mockReturnValue(
      new Promise<StrategyDocument>((resolve) => {
        resolveLoad = resolve
      }),
    )

    render(<App />)
    // Start opening s1; let the version lookup resolve and the load begin (now pending).
    fireEvent.click(screen.getByText('home-open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The user creates a NEW document while the load is still in flight → it claims a newer ticket.
    fireEvent.click(screen.getByText('home-new'))
    expect(screen.getByText('Fresh')).toBeInTheDocument()

    // The stale load now resolves — it is superseded, so it is dropped SILENTLY (no clobber, no error).
    await act(async () => {
      resolveLoad(newStrategyDocument('Loaded'))
      await Promise.resolve()
    })

    expect(screen.getByText('Fresh')).toBeInTheDocument() // newer document preserved
    expect(screen.queryByText('Loaded')).not.toBeInTheDocument() // stale load NOT applied
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // superseded silently — no misleading error
  })

  it('orders two rapid opens: the latest click wins, the earlier is dropped', async () => {
    mockVersions.mockResolvedValue({ versions: [1] })
    // Each id loads a distinctly-named document so we can see which one won.
    mockLoad.mockImplementation((id: string) =>
      Promise.resolve(newStrategyDocument(id === 's2' ? 'LoadedB' : 'LoadedA')),
    )

    render(<App />)
    // Two opens in quick succession, before either resolves — s2 is the user's latest click.
    fireEvent.click(screen.getByText('home-open')) // s1
    fireEvent.click(screen.getByText('home-open-b')) // s2 (latest)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('LoadedB')).toBeInTheDocument() // latest click won
    expect(screen.queryByText('LoadedA')).not.toBeInTheDocument() // earlier open dropped
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockLoad).toHaveBeenCalledTimes(1) // the superseded open never even loaded
    expect(mockLoad).toHaveBeenCalledWith('s2', 1)
  })

  it('surfaces an open failure ON HOME (the user never left it)', async () => {
    mockVersions.mockRejectedValue(new Error('list unavailable'))
    render(<App />)
    fireEvent.click(screen.getByText('home-open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Still on Home (the open failed) AND the error is visible — not hidden in the editor branch.
    expect(screen.getByText('home-open')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('list unavailable')
  })
})
