// Run submission + run list (M11.6). Two modes (backtest / forward) over one form: the request is
// built from the fields plus the CURRENT doc's identity (`strategy.id`/`version`) and the active
// dataset. Optional session fields are OMITTED when blank; forward REQUIRES `last_session` (a UX gate
// mirroring the server's 422). No numerical/portfolio logic lives here (invariant 5) — the server
// runs the strategy; this only submits and lists.
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { BacktestRunRequest, ForwardRunRequest } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { errorMessage, listRuns, runBacktest, runForward } from '../api/client'
import { useFetch } from '../useFetch'

type RunMode = 'backtest' | 'forward'

const DEFAULT_CASH = 1_000_000

export interface RunPanelProps {
  doc: StrategyDocument
  /** The active dataset id, or `undefined` when none is selected (submit is then disabled). */
  datasetId: string | undefined
  /** The currently selected run id (for row highlight). */
  selectedRunId: string | undefined
  /** Lift a run selection to the App (also called with the run id just created). */
  onSelectRun: (runId: string) => void
}

// Abbreviate a uuid run id for a compact list.
function abbrev(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

export function RunPanel({ doc, datasetId, selectedRunId, onSelectRun }: RunPanelProps): ReactElement {
  const [mode, setMode] = useState<RunMode>('backtest')
  const [initialCash, setInitialCash] = useState(String(DEFAULT_CASH))
  const [firstSession, setFirstSession] = useState('')
  const [lastSession, setLastSession] = useState('')
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const strategyId = doc.strategy.id
  const strategyVersion = doc.strategy.version

  // The run list via the shared hook: it resets to empty + loading when `strategyId` changes (so a
  // different strategy's runs never linger) and exposes `reload()` for the post-submit refresh.
  const runList = useFetch(() => listRuns(strategyId), [strategyId])
  const rows = runList.data?.runs ?? []
  // Submit failures and list-fetch failures share one banner (submit takes precedence when both set).
  const error = submitError ?? runList.error

  const onSubmit = async (): Promise<void> => {
    setSubmitError(undefined)
    const first = firstSession.trim()
    const last = lastSession.trim()

    // Forward requires last_session — gate client-side before building the request (the server also
    // enforces 422). Backtest may omit it (defaults to the dataset's last session).
    if (mode === 'forward' && last === '') {
      setSubmitError('Last session is required for a forward run.')
      return
    }

    // Empty input coerces to 0 via `Number('')`, which passes the finiteness guard and the server
    // accepts (only NEGATIVE cash is rejected) → a silent $0 backtest. Reject a blank field first.
    if (initialCash.trim() === '') {
      setSubmitError('Initial cash is required.')
      return
    }
    // Base body: identity from the doc, cash from the form. Optional sessions are added only when set
    // — never sent as empty strings.
    const cash = Number(initialCash)
    // Gate a non-finite cash (garbage → NaN, `1e999` → Infinity) client-side rather than round-tripping
    // a guaranteed 422. The server still validates authoritatively.
    if (!Number.isFinite(cash)) {
      setSubmitError('Initial cash must be a number.')
      return
    }
    setSubmitting(true)
    try {
      let runId: string
      if (mode === 'backtest') {
        const req: BacktestRunRequest = {
          dataset_id: datasetId as string,
          strategy_id: strategyId,
          strategy_version: strategyVersion,
          initial_cash: cash,
        }
        if (first !== '') {
          req.first_session = first
        }
        if (last !== '') {
          req.last_session = last
        }
        runId = (await runBacktest(req)).run_id
      } else {
        const req: ForwardRunRequest = {
          dataset_id: datasetId as string,
          strategy_id: strategyId,
          strategy_version: strategyVersion,
          initial_cash: cash,
          last_session: last,
        }
        if (first !== '') {
          req.first_session = first
        }
        runId = (await runForward(req)).run_id
      }
      runList.reload()
      onSelectRun(runId)
    } catch (e) {
      setSubmitError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = datasetId === undefined || submitting

  return (
    <div className="rpanel">
      <div className="rpanel__form">
        <div className="pform__field">
          <label className="pform__label" htmlFor="run-mode">
            Run mode
          </label>
          <select
            id="run-mode"
            aria-label="run mode"
            className="pform__input"
            value={mode}
            onChange={(e) => setMode(e.target.value as RunMode)}
          >
            <option value="backtest">Backtest</option>
            <option value="forward">Paper replay</option>
            {/* Live/broker execution is the machine's third operating mode — named honestly, marked
               deferred, and never a working control (no order ever reaches a real broker in v0). */}
            <option value="live" disabled>
              Live — not available in this version (future)
            </option>
          </select>
        </div>

        <div className="pform__field">
          <label className="pform__label" htmlFor="initial-cash">
            Initial cash
          </label>
          <input
            id="initial-cash"
            type="number"
            aria-label="initial cash"
            className="pform__input"
            value={initialCash}
            onChange={(e) => setInitialCash(e.target.value)}
          />
        </div>

        <div className="pform__field">
          <label className="pform__label" htmlFor="first-session">
            First session (optional)
          </label>
          <input
            id="first-session"
            type="date"
            aria-label="first session"
            className="pform__input"
            value={firstSession}
            onChange={(e) => setFirstSession(e.target.value)}
          />
        </div>

        <div className="pform__field">
          <label className="pform__label" htmlFor="last-session">
            Last session {mode === 'forward' ? '(required)' : '(optional)'}
          </label>
          <input
            id="last-session"
            type="date"
            aria-label="last session"
            className="pform__input"
            value={lastSession}
            onChange={(e) => setLastSession(e.target.value)}
          />
        </div>

        <button
          type="button"
          className="pform__btn pform__btn--primary"
          disabled={disabled}
          onClick={() => void onSubmit()}
        >
          {submitting ? 'Running…' : mode === 'forward' ? 'Run paper replay' : 'Run backtest'}
        </button>
      </div>

      <p className="rpanel__sim-notice" role="note">
        All runs are simulations over local data — no live trading. Backtest and paper replay both
        replay the same engine over the selected dataset.
      </p>

      <p className="rpanel__hint">
        Runs target the SAVED strategy at <code>{abbrev(strategyId)}</code> v{strategyVersion}. Save
        the current edits first.
      </p>
      {datasetId === undefined ? (
        <p className="rpanel__hint rpanel__hint--warn">Select a dataset to enable a run.</p>
      ) : null}

      {error !== undefined ? (
        <div className="rpanel__error" role="alert">
          {error}
        </div>
      ) : null}

      <ul className="rpanel__list">
        {rows.map((row) => (
          <li
            key={row.run_id}
            className={`rpanel__row ${row.run_id === selectedRunId ? 'is-selected' : ''}`}
          >
            <code className="rpanel__row-id">{abbrev(row.run_id)}</code>
            <span className="rpanel__row-meta">
              {row.mode} · {row.ok ? 'ok' : 'failed'} · ret {row.total_return}
            </span>
            <button type="button" className="pform__btn" onClick={() => onSelectRun(row.run_id)}>
              View
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
