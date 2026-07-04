// DatasetPanel: upload a dataset JSON file → POST, show identities, refresh the list; a JSON parse
// error and a 422 ApiClientError each show a clear message. The api client is mocked (no network);
// ApiClientError is the real class so `instanceof` works.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatasetList, DatasetStored } from '@quantize/quantize-api'
import { ApiClientError } from '../api/client'
import { DatasetPanel } from './DatasetPanel'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    uploadDataset: vi.fn(),
    listDatasets: vi.fn(),
    getDataset: vi.fn(),
  }
})

// eslint-disable-next-line import/first
import { getDataset, listDatasets, uploadDataset } from '../api/client'

const mockUpload = vi.mocked(uploadDataset)
const mockList = vi.mocked(listDatasets)
const mockGet = vi.mocked(getDataset)

const STORED: DatasetStored = {
  dataset_id: 'd'.repeat(64),
  dataset_fingerprint: 'f'.repeat(64),
  calendar_fingerprint: 'c'.repeat(64),
  sessions: 21,
  assets: 3,
}

const LIST: DatasetList = {
  datasets: [
    {
      dataset_id: 'd'.repeat(64),
      dataset_fingerprint: 'f'.repeat(64),
      calendar_fingerprint: 'c'.repeat(64),
      saved_at: '2026-07-04T00:00:00Z',
    },
  ],
}

// A File whose .text() resolves to the given string (jsdom's File.text() works, but we make it
// explicit and synchronous-friendly for the mocked flow).
function jsonFile(text: string): File {
  const file = new File([text], 'dataset.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  return file
}

beforeEach(() => {
  mockUpload.mockReset()
  mockList.mockReset().mockResolvedValue({ datasets: [] })
  mockGet.mockReset().mockResolvedValue(STORED)
})

describe('DatasetPanel', () => {
  it('uploads a parsed dataset JSON, shows the returned identities, and refreshes the list', async () => {
    mockUpload.mockResolvedValue(STORED)
    // First list (mount) empty; after upload the list contains the new dataset.
    mockList.mockResolvedValueOnce({ datasets: [] }).mockResolvedValueOnce(LIST)
    render(<DatasetPanel activeDatasetId={undefined} onSelectDataset={vi.fn()} />)

    const input = screen.getByLabelText(/upload dataset/i)
    fireEvent.change(input, { target: { files: [jsonFile('{"calendar":{},"observations":{}}')] } })

    // The parsed object is POSTed and the returned identities are shown.
    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith({ calendar: {}, observations: {} }))
    expect(await screen.findByText(/21/)).toBeInTheDocument() // sessions count
    expect(screen.getByText(/3/)).toBeInTheDocument() // assets count
    // The list refreshed (mount + post-upload).
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
  })

  it('shows a clear message when the file is not valid JSON (never POSTs)', async () => {
    render(<DatasetPanel activeDatasetId={undefined} onSelectDataset={vi.fn()} />)
    const input = screen.getByLabelText(/upload dataset/i)

    fireEvent.change(input, { target: { files: [jsonFile('not json{')] } })

    expect(await screen.findByText(/could not|invalid|parse/i)).toBeInTheDocument()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('surfaces a 422 invalid_dataset ApiClientError as a clear message', async () => {
    mockUpload.mockRejectedValue(new ApiClientError('invalid_dataset', 'dataset is invalid', 422))
    render(<DatasetPanel activeDatasetId={undefined} onSelectDataset={vi.fn()} />)
    const input = screen.getByLabelText(/upload dataset/i)

    fireEvent.change(input, { target: { files: [jsonFile('{"calendar":{},"observations":{}}')] } })

    expect(await screen.findByText('dataset is invalid')).toBeInTheDocument()
  })

  it('selecting a listed dataset invokes onSelectDataset with its id', async () => {
    mockList.mockResolvedValue(LIST)
    const onSelect = vi.fn()
    render(<DatasetPanel activeDatasetId={undefined} onSelectDataset={onSelect} />)

    const selectBtn = await screen.findByRole('button', { name: /select/i })
    fireEvent.click(selectBtn)
    expect(onSelect).toHaveBeenCalledWith('d'.repeat(64))
  })
})
