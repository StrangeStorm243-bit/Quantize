// The strategy bar (M13.3): the slim editor header for an OPEN document. It surfaces the document's
// identity (name · version · dirty) and the machine's primary verbs (Validate · Run · Save) at the
// top of the tool, plus the active-dataset chip and the session-cursor readout slot (wired in M13.7).
//
// Pure presentation: every value is passed in (the document is canonical in the store; dirty/dataset
// meta are App-held). No numerical/portfolio/compatibility logic (invariant 5).
import type { ReactElement } from 'react'
import type { DatasetStored } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'

export interface StrategyBarProps {
  doc: StrategyDocument
  /** True when the live document differs from the last saved/loaded baseline. */
  dirty: boolean
  saving: boolean
  datasetId: string | undefined
  /** Introspection metadata for the active dataset (M13.1) — enriches the chip with its date range. */
  datasetMeta: DatasetStored | undefined
  /** The selected session date (M13.7). Null until a run+cursor exist — renders an empty slot. */
  sessionCursor: string | null
  onValidate: () => void
  onRun: () => void
  onSave: () => void
  onChooseDataset: () => void
  onHome: () => void
}

function abbrev(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export function StrategyBar(props: StrategyBarProps): ReactElement {
  const {
    doc,
    dirty,
    saving,
    datasetId,
    datasetMeta,
    sessionCursor,
    onValidate,
    onRun,
    onSave,
    onChooseDataset,
    onHome,
  } = props
  return (
    <div className="sbar">
      <button type="button" className="sbar__home" onClick={onHome} title="Back to home">
        ← Home
      </button>
      <span className="sbar__name">{doc.strategy.name}</span>
      <span className="sbar__version">v{doc.strategy.version}</span>
      {dirty ? (
        <span className="sbar__dirty" title="Unsaved changes" aria-label="unsaved changes">
          ● unsaved
        </span>
      ) : null}

      <div className="sbar__verbs">
        <button type="button" className="pform__btn" onClick={onValidate}>
          Validate
        </button>
        <button type="button" className="pform__btn" onClick={onRun}>
          Run
        </button>
        <button
          type="button"
          className="pform__btn pform__btn--primary"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <button
        type="button"
        className="sbar__chip"
        onClick={onChooseDataset}
        aria-label="active dataset"
      >
        {datasetId === undefined ? (
          'Dataset: none — choose'
        ) : (
          <>
            Dataset: <code>{abbrev(datasetId)}</code>
            {datasetMeta !== undefined ? (
              <span className="sbar__chip-range">
                {' '}
                {datasetMeta.first_session} → {datasetMeta.last_session}
              </span>
            ) : null}
          </>
        )}
      </button>

      <span className="sbar__cursor" aria-label="session cursor">
        {sessionCursor ?? '—'}
      </span>
    </div>
  )
}
