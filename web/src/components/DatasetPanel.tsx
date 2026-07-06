// Dataset upload + discovery + selection (M11.6, D12). Upload reads a dataset JSON file, parses it,
// and POSTs it verbatim; the list comes from `GET /v1/datasets` (M11.1). The active dataset id is
// lifted to the App via `onSelectDataset` (and remembered in localStorage as a UX convenience ONLY —
// never as a source of truth for server state). No numerical/portfolio logic lives here (invariant 5).
import { useEffect, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import type { DatasetStored, DatasetUpload } from '@quantize/quantize-api'
import { errorMessage, getDataset, listDatasets, uploadDataset } from '../api/client'
import { useFetch } from '../useFetch'

/** localStorage key for the last-selected dataset id (UX convenience only). */
export const LAST_DATASET_KEY = 'quantize.lastDatasetId'

export interface DatasetPanelProps {
  /** The active dataset id (App-held), or `undefined` when none is selected. */
  activeDatasetId: string | undefined
  /** Lift the selected dataset id to the App. */
  onSelectDataset: (datasetId: string) => void
}

// Abbreviate a 64-hex content id for display (full id still drives selection).
function abbrev(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export function DatasetPanel({ activeDatasetId, onSelectDataset }: DatasetPanelProps): ReactElement {
  const [uploaded, setUploaded] = useState<DatasetStored | undefined>(undefined)
  const [selectedMeta, setSelectedMeta] = useState<DatasetStored | undefined>(undefined)
  const [uploadError, setUploadError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // The dataset list via the shared hook; `reload()` refreshes it after a successful upload.
  const datasetList = useFetch(() => listDatasets(), [])
  const rows = datasetList.data?.datasets ?? []
  // Upload/parse failures and list-fetch failures share one banner (upload takes precedence).
  const error = uploadError ?? datasetList.error

  // Show counts for the selected dataset (fetch-metadata; the list rows carry only identities).
  useEffect(() => {
    if (activeDatasetId === undefined) {
      setSelectedMeta(undefined)
      return
    }
    let cancelled = false
    getDataset(activeDatasetId)
      .then((meta) => {
        if (!cancelled) {
          setSelectedMeta(meta)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedMeta(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeDatasetId])

  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setUploadError(undefined)
    setUploaded(undefined)
    const file = event.target.files?.[0]
    // Reset the input value so re-selecting the SAME file after a parse/422 error re-fires `change`
    // (otherwise the value is unchanged, no change event fires → a silent dead retry). The `File`
    // reference is already captured, so clearing the input does not affect the read below.
    event.target.value = ''
    if (file === undefined) {
      return
    }
    let parsed: unknown
    try {
      const text = await file.text()
      parsed = JSON.parse(text)
    } catch {
      setUploadError('Could not parse the file as JSON. Upload a valid dataset JSON document.')
      return
    }
    setBusy(true)
    try {
      // POST the parsed document verbatim; the server is authoritative on dataset validity (422).
      const stored = await uploadDataset(parsed as DatasetUpload)
      setUploaded(stored)
      datasetList.reload()
    } catch (e) {
      setUploadError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onSelect = (datasetId: string): void => {
    onSelectDataset(datasetId)
    try {
      window.localStorage.setItem(LAST_DATASET_KEY, datasetId)
    } catch {
      // localStorage is a convenience only; a failure (private mode / quota) never blocks selection.
    }
  }

  return (
    <div className="dpanel">
      <div className="dpanel__upload">
        <label className="pform__label" htmlFor="dataset-file">
          Upload dataset JSON
        </label>
        <input
          id="dataset-file"
          type="file"
          accept="application/json"
          aria-label="upload dataset"
          disabled={busy}
          onChange={(e) => void onFile(e)}
        />
      </div>

      {error !== undefined ? (
        <div className="dpanel__error" role="alert">
          {error}
        </div>
      ) : null}

      {uploaded !== undefined ? (
        <div className="dpanel__identities">
          <div>
            Uploaded <code>{abbrev(uploaded.dataset_id)}</code>
          </div>
          <div className="dpanel__meta">
            {uploaded.sessions} sessions · {uploaded.assets} assets
          </div>
          <div className="dpanel__meta">
            dataset fp <code>{abbrev(uploaded.dataset_fingerprint)}</code> · calendar fp{' '}
            <code>{abbrev(uploaded.calendar_fingerprint)}</code>
          </div>
        </div>
      ) : null}

      {activeDatasetId !== undefined ? (
        <div className="dpanel__active">
          Active dataset: <code>{abbrev(activeDatasetId)}</code>
          {selectedMeta !== undefined ? (
            <span className="dpanel__meta">
              {' '}
              ({selectedMeta.sessions} sessions · {selectedMeta.assets} assets)
            </span>
          ) : null}
        </div>
      ) : null}

      <ul className="dpanel__list">
        {rows.map((row) => (
          <li key={row.dataset_id} className="dpanel__row">
            <code className="dpanel__row-id">{abbrev(row.dataset_id)}</code>
            <span className="dpanel__row-meta">{row.saved_at}</span>
            <button
              type="button"
              className="pform__btn"
              disabled={row.dataset_id === activeDatasetId}
              onClick={() => onSelect(row.dataset_id)}
            >
              {row.dataset_id === activeDatasetId ? 'Selected' : 'Select'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
