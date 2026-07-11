// The Home screen (M13.3): the app's front door, shown when no document is open. Strategies are
// documents you OPEN (not a tab). Home offers the "Walk the journey" demo entry (the §13 validation
// front door), a New-strategy action, the recent/saved strategies list, and dataset management (the
// former datasets tab, demoted to a Home view + the strategy-bar chip). No business logic here —
// strategy CRUD is lifted to the App; this presents state and calls the handlers.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { listStrategies } from '../api/client'
import { useFetch } from '../useFetch'
import { DatasetPanel } from './DatasetPanel'

export interface HomeProps {
  onNew: (name: string) => void
  onOpen: (strategyId: string) => void
  datasetId: string | undefined
  onSelectDataset: (id: string) => void
}

// The seeded ETF Momentum Rotation demo, matched by name so the journey card lights up when it is
// present (seeding is out of scope here) and falls back to an honest empty state when it is not.
// Exported so the App's journey checklist infers the `open-demo` step from the same single rule (DRY).
export const DEMO_NAME = /momentum/i

export function Home({ onNew, onOpen, datasetId, onSelectDataset }: HomeProps): ReactElement {
  const [name, setName] = useState('Untitled')
  const strategies = useFetch(() => listStrategies(), [])
  // The API lists one summary per (strategy_id, version); opening a strategy loads its LATEST version
  // (see App.handleOpen). Collapse to one row per strategy at its latest version so the displayed
  // version matches what Open loads — a "v1" row that silently opened v2 was confusing (M13.9 O2).
  // Presentation-only dedup (invariant 5): keep the first-seen order, keep the highest version.
  const rows = Array.from(
    (strategies.data?.strategies ?? [])
      .reduce((byId, s) => {
        const prev = byId.get(s.strategy_id)
        if (prev === undefined || s.version > prev.version) {
          byId.set(s.strategy_id, s)
        }
        return byId
      }, new Map<string, NonNullable<typeof strategies.data>['strategies'][number]>())
      .values(),
  )
  const demo = rows.find((r) => DEMO_NAME.test(r.name))

  return (
    <div className="home">
      <header className="home__hero">
        <h1 className="home__title">Quantize</h1>
        <p className="home__tag">A visual IDE for quantitative trading systems.</p>
      </header>

      <section className="home__journey" aria-label="walk the journey">
        <h2 className="home__card-title">Walk the journey</h2>
        <p className="home__card-body">
          Open the ETF Momentum Rotation demo, run a backtest, read the trace, and extract a
          component — the whole machine end to end.
        </p>
        {demo !== undefined ? (
          <button
            type="button"
            className="pform__btn pform__btn--primary"
            onClick={() => onOpen(demo.strategy_id)}
          >
            Open the demo strategy
          </button>
        ) : (
          <p className="home__hint">The seeded demo strategy is not available in this database yet.</p>
        )}
      </section>

      <section className="home__new" aria-label="new strategy">
        <h2 className="home__card-title">New strategy</h2>
        <div className="home__new-row">
          <input
            type="text"
            className="pform__input"
            aria-label="new strategy name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="pform__btn"
            onClick={() => onNew(name.trim() === '' ? 'Untitled' : name.trim())}
          >
            Create
          </button>
        </div>
      </section>

      <section className="home__recent" aria-label="recent strategies">
        <h2 className="home__card-title">Recent strategies</h2>
        {strategies.loading ? <p className="home__hint">Loading…</p> : null}
        {strategies.error !== undefined ? (
          <p className="home__hint home__hint--error">Failed to load strategies.</p>
        ) : null}
        {!strategies.loading && strategies.error === undefined && rows.length === 0 ? (
          <p className="home__hint">No saved strategies yet — create one above.</p>
        ) : null}
        <ul className="home__list">
          {rows.map((row) => (
            <li key={`${row.strategy_id}:${row.version}`} className="home__row">
              <span className="home__row-name">{row.name}</span>
              <span className="home__row-meta">v{row.version}</span>
              <button type="button" className="pform__btn" onClick={() => onOpen(row.strategy_id)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="home__datasets" aria-label="datasets">
        <h2 className="home__card-title">Datasets</h2>
        <DatasetPanel activeDatasetId={datasetId} onSelectDataset={onSelectDataset} />
      </section>
    </div>
  )
}
