// App save flow (M13.3): strategy CRUD lifted from the (removed) StrategyPanel into the App. Save
// persists the current document; a byte-identical save is idempotent, and a 409 conflict at an
// existing (id, version) triggers a version bump + one retry. Dirty is a pure object-identity check
// that clears once the saved object becomes the baseline. NO network — the api client is mocked.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StrategySaved } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual, // keep the REAL ApiClientError so `instanceof` works in the App's 409 branch
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
    saveStrategy: vi.fn(),
  }
})

// Home stub: enter the editor. Canvas stub: a button that mutates the doc (making it dirty). The
// other heavy children are stubbed so this stays focused on the save flow.
vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))
vi.mock('./components/Canvas', () => ({
  Canvas: (props: { actions: { addNode: (args: unknown) => void } }) => (
    <button
      type="button"
      onClick={() =>
        props.actions.addNode({
          typeId: 'x.y',
          typeVersion: '1.0.0',
          params: {},
          position: { x: 0, y: 0 },
        })
      }
    >
      mutate-doc
    </button>
  ),
}))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div /> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div /> }))

// eslint-disable-next-line import/first
import { App } from './App'
// eslint-disable-next-line import/first
import { ApiClientError, saveStrategy } from './api/client'

const mockSave = vi.mocked(saveStrategy)

afterEach(async () => {
  vi.clearAllMocks()
  await act(async () => {
    await Promise.resolve()
  })
})

function enterEditorAndEdit(): void {
  render(<App />)
  fireEvent.click(screen.getByText('home-new'))
  fireEvent.click(screen.getByText('mutate-doc')) // a mutation → the document is now dirty
}

describe('App save flow (M13.3)', () => {
  it('marks the document dirty after an edit and clears it on a successful save', async () => {
    mockSave.mockResolvedValue({ strategy_id: 's1', version: 1 })
    enterEditorAndEdit()
    expect(screen.getByLabelText('unsaved changes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    // The saved object is the new dirty baseline → the indicator clears.
    await waitFor(() => expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument())
  })

  it('on a 409 conflict, bumps the version and retries the save once', async () => {
    mockSave
      .mockRejectedValueOnce(new ApiClientError('artifact_conflict', 'exists', 409))
      .mockResolvedValueOnce({ strategy_id: 's1', version: 2 })
    enterEditorAndEdit()
    expect(screen.getByText('v1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2)) // original + bumped retry
    // The document version was bumped to 2 before the retry.
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument())
    const bumped = mockSave.mock.calls[1][0] as StrategyDocument
    expect(bumped.strategy.version).toBe(2)
  })

  it('surfaces a non-conflict save error without bumping', async () => {
    mockSave.mockRejectedValue(new ApiClientError('unexpected_error', 'boom', 500))
    enterEditorAndEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
    expect(mockSave).toHaveBeenCalledTimes(1) // no retry on a non-409 error
    expect(screen.getByText('v1')).toBeInTheDocument()
  })

  it('refuses the 409 retry (no clobber) when the document changed during the save', async () => {
    // The save is left pending so we can edit the live document before the 409 arrives.
    let rejectSave: (e: unknown) => void = () => {}
    mockSave.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    enterEditorAndEdit() // captured document D1 (v1 + one node), dirty
    fireEvent.click(screen.getByRole('button', { name: 'Save' })) // captures D1, request pending
    fireEvent.click(screen.getByText('mutate-doc')) // a live edit during the save → D2

    await act(async () => {
      rejectSave(new ApiClientError('artifact_conflict', 'exists', 409))
      await Promise.resolve()
    })

    // The guard refuses: the bumped STALE document never overwrote the live edit.
    expect(mockSave).toHaveBeenCalledTimes(1) // no retry save was sent
    expect(screen.getByRole('alert')).toHaveTextContent(/Document changed during save/)
    expect(screen.getByText('v1')).toBeInTheDocument() // never bumped to v2
    expect(screen.getByLabelText('unsaved changes')).toBeInTheDocument() // edits still live + dirty
  })

  it('does not touch a newer document when a stale save resolves after navigation', async () => {
    let resolveSave: (v: StrategySaved) => void = () => {}
    mockSave.mockImplementationOnce(
      () =>
        new Promise<StrategySaved>((resolve) => {
          resolveSave = resolve
        }),
    )
    enterEditorAndEdit() // document D1 (dirty), generation G
    fireEvent.click(screen.getByRole('button', { name: 'Save' })) // captures G, request pending

    // Navigate Home and create a NEW document (a newer generation, clean baseline).
    fireEvent.click(screen.getByRole('button', { name: /Home/ }))
    fireEvent.click(screen.getByText('home-new'))
    expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument() // new doc is clean

    // The stale D1 save resolves — it must NOT overwrite the newer document's baseline or its controls.
    await act(async () => {
      resolveSave({ strategy_id: 's1', version: 1 })
      await Promise.resolve()
    })
    expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument() // still clean
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument() // not stuck on "Saving…"
  })
})
