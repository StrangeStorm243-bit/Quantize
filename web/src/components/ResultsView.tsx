// Results for one run (M11.6, D9). Fetch `GET /v1/runs/{id}` and RENDER the persisted record — the
// SVG valuations chart, the summary stats, and the fills/evaluations tables. EVERY displayed number
// is a record field formatted for display; nothing is computed here (invariant 5). An `ok:false`
// record is a valid run to inspect, not an error.
import type { ReactElement } from 'react'
import type { RunRecordResponse } from '@quantize/quantize-api'
import { SvgLineChart } from './SvgLineChart'

export interface ResultsViewProps {
  /** The selected run id, or `undefined` when nothing is selected. */
  runId: string | undefined
  /** The fetched run record (owned by the App so it survives results↔trace tab flips), or undefined. */
  record: RunRecordResponse | undefined
  /** True while the App is fetching the record. */
  loading: boolean
  /** A record-fetch error message, or undefined. */
  error: string | undefined
}

// Display formatting only — a raw record number rendered with a fixed precision. Non-finite guards
// keep a malformed value visible rather than crashing; this is presentation, not derivation.
function fmt(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value)
}

export function ResultsView({ runId, record: data, loading, error }: ResultsViewProps): ReactElement {
  if (runId === undefined) {
    return <div className="results results--empty">Select a run to view its results.</div>
  }
  // During a run switch the App briefly still holds the PREVIOUS run's record (its reset effect
  // runs only after paint), so also gate on the record's own run_id — never paint another run's
  // numbers under this runId. Mirrors TraceView's sessions guard.
  if (loading || (data !== undefined && data.record.run_id !== runId)) {
    return <div className="results results--empty">Loading run…</div>
  }
  if (error !== undefined) {
    return (
      <div className="results__error" role="alert">
        {error}
      </div>
    )
  }
  if (data === undefined) {
    return <div className="results results--empty">No results.</div>
  }

  const { record, replay_verifiable } = data

  return (
    <div className="results">
      <div className="results__head">
        <span className={`results__status ${record.ok ? 'is-ok' : 'is-fail'}`}>
          {record.ok ? 'ok' : 'ok: no — run failed'}
        </span>
        <span className="results__mode">{record.mode}</span>
        <span className={`results__badge ${replay_verifiable ? 'is-verifiable' : 'is-unverifiable'}`}>
          {replay_verifiable ? 'replay-verifiable' : 'replay: unverifiable'}
        </span>
      </div>

      <SvgLineChart points={record.valuations} />

      <dl className="results__stats">
        <div className="results__stat">
          <dt>Total return</dt>
          <dd>{fmt(record.total_return)}</dd>
        </div>
        <div className="results__stat">
          <dt>Max drawdown</dt>
          <dd>{fmt(record.max_drawdown)}</dd>
        </div>
        <div className="results__stat">
          <dt>Final cash</dt>
          <dd>{fmt(record.final_cash, 2)}</dd>
        </div>
      </dl>

      <section className="results__section">
        <h4 className="results__section-title">Fills ({record.fills.length})</h4>
        {record.fills.length > 0 ? (
          <table className="results__table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Side</th>
                <th>Asset</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Scaled</th>
              </tr>
            </thead>
            <tbody>
              {record.fills.map((fill, i) => (
                <tr key={`${fill.session_date}:${fill.asset}:${i}`}>
                  <td>{fill.session_date}</td>
                  <td>{fill.side}</td>
                  <td>{fill.asset}</td>
                  <td>{fill.quantity}</td>
                  <td>{fill.price}</td>
                  <td>{fill.scaled ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="results__empty-row">No fills.</p>
        )}
      </section>

      <section className="results__section">
        <h4 className="results__section-title">Evaluations ({record.evaluations.length})</h4>
        {record.evaluations.length > 0 ? (
          <table className="results__table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Portfolio value</th>
                <th>#Orders</th>
                <th>Fill session</th>
              </tr>
            </thead>
            <tbody>
              {record.evaluations.map((evaluation, i) => (
                <tr key={`${evaluation.session_date}:${i}`}>
                  <td>{evaluation.session_date}</td>
                  <td>{evaluation.portfolio_value ?? '—'}</td>
                  <td>{evaluation.orders.length}</td>
                  <td>{evaluation.fill_session ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="results__empty-row">No evaluations.</p>
        )}
      </section>

      {record.notes.length > 0 ? (
        <section className="results__section">
          <h4 className="results__section-title">Notes ({record.notes.length})</h4>
          <ul className="results__list">
            {record.notes.map((note, i) => (
              <li key={`${note.code}:${i}`}>
                <span className="results__code">{note.code}</span> {note.session_date} — {note.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {record.diagnostics.length > 0 ? (
        <section className="results__section">
          <h4 className="results__section-title">Diagnostics ({record.diagnostics.length})</h4>
          <ul className="results__list">
            {record.diagnostics.map((diag, i) => (
              <li key={`${diag.code}:${i}`}>
                <span className="results__code">{diag.code}</span> {diag.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
