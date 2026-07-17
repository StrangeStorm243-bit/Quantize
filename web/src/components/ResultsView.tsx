// Results for one run (M11.6, D9). Fetch `GET /v1/runs/{id}` and RENDER the persisted record — the
// SVG valuations chart, the summary stats, and the fills/evaluations tables. EVERY displayed number
// is a record field formatted for display; nothing is computed here (invariant 5). An `ok:false`
// record is a valid run to inspect, not an error.
import type { ReactElement } from 'react'
import type { RunRecordResponse } from '@quantize/quantize-api'
import { fmtValue, verbatimTitle } from '../format'
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
  /** Optional (M13.7): clicking the chart / an evaluation or fill row selects that session (App sets the
   *  cursor + opens Trace). Every date passed is a server field; the view derives nothing. */
  onSelectSession?: ((date: string) => void) | undefined
}

// Display formatting: the ONE shared display formatter (D-27 — Inspector, TraceView, ResultsView,
// RunPanel all render numbers identically); the verbatim served number stays in each cell's title.

export function ResultsView({
  runId,
  record: data,
  loading,
  error,
  onSelectSession,
}: ResultsViewProps): ReactElement {
  if (runId === undefined) {
    return <div className="results results--empty">Select a run to view its results.</div>
  }
  // The run-identity gate lives UPSTREAM now (run/useDebugLoopState): the App hands ResultsView either
  // the SELECTED run's record or `loading` — the post-switch stale window (the record effect resets
  // only after paint) is folded into `loading` there. So this view no longer re-gates on run_id; it
  // trusts a matching-or-loading record and simply shows the loading state when told to.
  if (loading) {
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

  // A session cell's content: when the parent wired `onSelectSession`, wrap the SERVER date in a button
  // so it is keyboard-reachable without restructuring the table; otherwise render the plain date text as
  // before. The date is passed through verbatim — the view selects a session, it derives nothing.
  const sessionCell = (date: string): ReactElement | string =>
    onSelectSession !== undefined ? (
      <button
        type="button"
        className="results__rowbtn"
        onClick={() => onSelectSession(date)}
      >
        {date}
      </button>
    ) : (
      date
    )

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

      {/* Axis labels through the shared formatter too (D-27) — pure display of the served points. */}
      <SvgLineChart points={record.valuations} onSelectPoint={onSelectSession} formatValue={fmtValue} />

      <dl className="results__stats">
        <div className="results__stat">
          <dt>Total return</dt>
          <dd {...verbatimTitle(record.total_return)}>{fmtValue(record.total_return)}</dd>
        </div>
        <div className="results__stat">
          <dt>Max drawdown</dt>
          <dd {...verbatimTitle(record.max_drawdown)}>{fmtValue(record.max_drawdown)}</dd>
        </div>
        <div className="results__stat">
          <dt>Final cash</dt>
          {/* D-27 flattened the old dedicated 2-dp money rendering (fmt(x, 2)) into the ONE shared
              formatter — integer cash shows bare ('1000000', not '1000000.00'); verbatim in title. */}
          <dd {...verbatimTitle(record.final_cash)}>{fmtValue(record.final_cash)}</dd>
        </div>
      </dl>

      {/* Evaluations are the GRAPH's per-session decisions — the Target Portfolio (target_weights) the
          strategy asked for, and the orders the engine reconciled from it — distinct from the engine's
          fills below, so they get their own section ABOVE the Engine stage. Every weight/order value is
          a served record field formatted for display (fmtValue), never a client-side computation
          (invariant 5): the story is Target Portfolio → Orders → Fills → Portfolio Evolution. */}
      <section className="results__section">
        <h4 className="results__section-title">Evaluations ({record.evaluations.length})</h4>
        {record.evaluations.length > 0 ? (
          <table className="results__table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Target weights</th>
                <th>Orders</th>
                <th>Fill session</th>
              </tr>
            </thead>
            <tbody>
              {record.evaluations.map((evaluation, i) => (
                <tr key={`${evaluation.session_date}:${i}`}>
                  <td>{sessionCell(evaluation.session_date)}</td>
                  <td>
                    {evaluation.target_weights.length > 0 ? (
                      <ul className="results__cells">
                        {evaluation.target_weights.map(([asset, weight], j) => (
                          <li key={`${asset}:${j}`} {...verbatimTitle(weight)}>{`${asset} ${fmtValue(weight)}`}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="results__muted">no targets</span>
                    )}
                  </td>
                  <td>
                    {evaluation.orders.length > 0 ? (
                      <ul className="results__cells">
                        {evaluation.orders.map((order, j) => (
                          <li key={`${order.asset}:${j}`}>{`${order.side} ${order.asset} ${order.quantity}`}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="results__muted">no orders</span>
                    )}
                  </td>
                  <td>{evaluation.fill_session ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="results__empty-row">No evaluations.</p>
        )}
      </section>

      {/* The Engine stage (invariant 2): the strategy graph ends at portfolio targets; the ENGINE — not
          the graph — reconciles targets into orders and fills them at the next session open. Fills are
          engine output, so they live under this explicit section. */}
      <section className="results__section results__section--engine" aria-label="engine stage">
        <h4 className="results__section-title">Engine — targets → orders → fills</h4>
        <p className="results__engine-note">
          The strategy graph ends at portfolio targets; the engine reconciles targets into orders and
          fills them at the next session open.
        </p>
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
                  <td>{sessionCell(fill.session_date)}</td>
                  <td>{fill.side}</td>
                  <td>{fill.asset}</td>
                  <td {...verbatimTitle(fill.quantity)}>{fmtValue(fill.quantity)}</td>
                  <td {...verbatimTitle(fill.price)}>{fmtValue(fill.price)}</td>
                  <td>{fill.scaled ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="results__empty-row">No fills.</p>
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
