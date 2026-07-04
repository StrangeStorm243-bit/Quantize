// StrategyPanel: list refresh, load-replaces-doc, and the 409/version-bump save flow. The api client
// is mocked (no network); ApiClientError is the real class. Store reducers are the real ones so the
// bump is exercised end-to-end.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StrategyList, StrategySaved, VersionList } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError } from '../api/client'
import { newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { StrategyPanel } from './StrategyPanel'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    listStrategies: vi.fn(),
    listStrategyVersions: vi.fn(),
    loadStrategyVersion: vi.fn(),
    saveStrategy: vi.fn(),
  }
})

// eslint-disable-next-line import/first
import { listStrategies, listStrategyVersions, loadStrategyVersion, saveStrategy } from '../api/client'

const mockList = vi.mocked(listStrategies)
const mockVersions = vi.mocked(listStrategyVersions)
const mockLoad = vi.mocked(loadStrategyVersion)
const mockSave = vi.mocked(saveStrategy)

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(),
    removeNode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    setParams: vi.fn(),
    setNodeUi: vi.fn(),
    replace: vi.fn(),
  }
}

const LIST: StrategyList = {
  strategies: [{ strategy_id: 's1', name: 'Momentum', version: 1, schema_version: '0.1.0', saved_at: '2026-07-04T00:00:00Z' }],
}

beforeEach(() => {
  mockList.mockReset().mockResolvedValue(LIST)
  mockVersions.mockReset()
  mockLoad.mockReset()
  mockSave.mockReset()
})

describe('StrategyPanel', () => {
  it('lists strategies on mount and refreshes after a successful save', async () => {
    const doc = newStrategyDocument('t')
    const saved: StrategySaved = { strategy_id: doc.strategy.id, version: 1 }
    mockSave.mockResolvedValue(saved)
    render(<StrategyPanel doc={doc} actions={stubActions()} />)

    expect(await screen.findByText('Momentum')).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(doc))
    // A successful save refreshes the list.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })

  it('runs the 409/bump flow: bumps the version and retries the save once', async () => {
    const doc = newStrategyDocument('t') // version 1
    const actions = stubActions()
    mockSave
      .mockRejectedValueOnce(new ApiClientError('artifact_conflict', 'exists', 409))
      .mockResolvedValueOnce({ strategy_id: doc.strategy.id, version: 2 })
    render(<StrategyPanel doc={doc} actions={actions} />)
    await screen.findByText('Momentum')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The conflict dialog offers version N+1 = 2.
    const confirm = await screen.findByRole('button', { name: 'Save as version 2' })
    fireEvent.click(confirm)

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
    // The retry saved a doc whose version was bumped to 2 …
    const retriedDoc = mockSave.mock.calls[1][0] as StrategyDocument
    expect(retriedDoc.strategy.version).toBe(2)
    // … and the bumped doc was made canonical via replace.
    expect(actions.replace).toHaveBeenCalledTimes(1)
    const replaced = (actions.replace as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as StrategyDocument
    expect(replaced.strategy.version).toBe(2)
    // Verbatim except the version: same id/name preserved.
    expect(replaced.strategy.id).toBe(doc.strategy.id)
    expect(replaced.strategy.name).toBe(doc.strategy.name)
  })

  it('disables Save while a save is in flight (no concurrent double-submit)', async () => {
    const doc = newStrategyDocument('t')
    let resolveSave: (v: StrategySaved) => void = () => {}
    mockSave.mockReturnValue(
      new Promise<StrategySaved>((resolve) => {
        resolveSave = resolve
      }),
    )
    render(<StrategyPanel doc={doc} actions={stubActions()} />)
    await screen.findByText('Momentum')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // In-flight: the button is disabled, so a second click cannot fire a second concurrent save.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }))
    expect(mockSave).toHaveBeenCalledTimes(1)

    // The finally re-enables the button once the save settles.
    resolveSave({ strategy_id: doc.strategy.id, version: 1 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled())
  })

  it('loads the latest version and replaces the store doc verbatim', async () => {
    const doc = newStrategyDocument('t')
    const actions = stubActions()
    const loaded = { ...newStrategyDocument('Loaded'), extensions: { x: 1 } } as StrategyDocument
    const versions: VersionList = { versions: [1, 2] }
    mockVersions.mockResolvedValue(versions)
    mockLoad.mockResolvedValue(loaded)
    render(<StrategyPanel doc={doc} actions={actions} />)
    await screen.findByText('Momentum')

    fireEvent.click(screen.getByRole('button', { name: 'Load' }))

    // Latest version (2) is requested, and the loaded doc replaces the store doc verbatim.
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith('s1', 2))
    await waitFor(() => expect(actions.replace).toHaveBeenCalledWith(loaded))
  })
})
