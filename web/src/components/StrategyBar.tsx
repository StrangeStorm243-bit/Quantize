// The strategy bar (M13.3): the slim editor header for an OPEN document. It surfaces the document's
// identity (name · version · dirty) and the machine's primary verbs (Validate · Run · Save) at the
// top of the tool, plus the active-dataset chip and the session-cursor readout slot (wired in M13.7).
//
// Pure presentation: every value is passed in (the document is canonical in the store; dirty/dataset
// meta are App-held). No numerical/portfolio/compatibility logic (invariant 5).
import type { ReactElement } from 'react'
import type { DatasetStored } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { scheduleSummary } from '../document/schedule'

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
  /** Cursor axis: the run's server session dates in order; empty without a run/record. */
  sessionDates: string[]
  /** The evaluated subset (from record.evaluations) — distinguishes warm-up/no-eval sessions. */
  evaluatedSessions: ReadonlySet<string>
  onCursorChange: (date: string) => void
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
    sessionDates,
    evaluatedSessions,
    onCursorChange,
    onValidate,
    onRun,
    onSave,
    onChooseDataset,
    onHome,
  } = props
  // Pure list-index navigation over the SERVER date array — no numerics (invariant 5). `i` is the
  // cursor's position in the run's session list, or -1 when there is no cursor (no run selected, or
  // the cursor briefly cleared during a run switch). Prev/next simply step to the neighbouring date.
  const i = sessionCursor === null ? -1 : sessionDates.indexOf(sessionCursor)
  const hasRun = sessionDates.length > 0
  const evaluated = sessionCursor !== null && evaluatedSessions.has(sessionCursor)
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

      {/* The strategy's evaluation cadence, read straight from the document (M13.7.5). It explains the
          no-evaluation sessions the cursor steps across — a monthly strategy only decides on rebalance
          days — so the "no evaluation this session" state is not mysterious. Pure display (invariant 5). */}
      <span className="sbar__schedule" aria-label="evaluation schedule">
        {scheduleSummary(doc.schedule.kind)}
      </span>

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

      {/* The session cursor: without a run, just an em-dash (no stepper). With a run, a ◀/▶ stepper
          around the current date + a marker distinguishing an evaluated session from one the engine
          skipped (warm-up / no evaluation). Navigation is bounded to the run's own session list. */}
      <span className="sbar__cursor" aria-label="session cursor">
        {hasRun ? (
          <>
            <button
              type="button"
              className="sbar__cursor-step"
              aria-label="previous session"
              onClick={() => onCursorChange(sessionDates[i - 1])}
              disabled={i <= 0}
            >
              ◀
            </button>
            <span className="sbar__cursor-date">
              {sessionCursor ?? '—'}
              {sessionCursor !== null ? (
                evaluated ? (
                  <span className="sbar__cursor-eval"> · evaluated</span>
                ) : (
                  <span className="sbar__cursor-noeval"> · no evaluation</span>
                )
              ) : null}
            </span>
            <button
              type="button"
              className="sbar__cursor-step"
              aria-label="next session"
              onClick={() => onCursorChange(sessionDates[i + 1])}
              disabled={i === -1 || i === sessionDates.length - 1}
            >
              ▶
            </button>
          </>
        ) : (
          '—'
        )}
      </span>
    </div>
  )
}
