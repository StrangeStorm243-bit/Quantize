// The Data Source card (M13.4) — the machine's first-class entry point, rendered as the FACE of a
// `data`-category node (the handles live in the node frame; this is the body). It composes facts the
// system already holds: the source kind + provenance, the connected universe, and the dataset's
// calendar bounds. Every value is served dataset metadata or a document param passed in — the card
// COMPUTES nothing (invariant 5). Unbound / not-resolvable states are explicit, never blank.
import type { ReactElement } from 'react'
import type { DatasetStored } from '@quantize/quantize-api'
import type { NodeValidity } from '../document/flow'
import { CategoryIcon } from '../icons/categories'
import { ValidityBadge } from './ValidityBadge'

export interface DataSourceCardProps {
  displayName: string
  /** The active dataset id (the strategy-bar binding). Absent → the explicit unbound state. */
  datasetId?: string | undefined
  /** Served introspection for the active dataset (calendar bounds, counts, fingerprint). */
  datasetMeta?: DatasetStored | undefined
  /** Universe tickers resolved from the connected `universe.*` node's params; `null` = unbound. */
  universeTickers?: string[] | null | undefined
  /** False inside a read-only component view where the binding is not resolvable (defaults true). */
  resolvable?: boolean | undefined
  /** The latest validation verdict for this node (D-7). */
  validity?: NodeValidity | undefined
}

// Content-addressed ids/fingerprints are long — abbreviate to head…tail for the card face.
function abbrev(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id
}

const PLACEHOLDER = 'Bound at the strategy level'

// One labelled fact row: a dim label and its value (or an explicit placeholder value).
function Row(props: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="dscard__row">
      <span className="dscard__label">{props.label}</span>
      <span className="dscard__value">{props.children}</span>
    </div>
  )
}

export function DataSourceCard(props: DataSourceCardProps): ReactElement {
  const { displayName, datasetId, datasetMeta, universeTickers, resolvable = true, validity } = props

  // Universe row content: strategy-level placeholder in a component view; the tickers when connected;
  // an explicit "no universe" otherwise. Never blank.
  const universeRow = !resolvable
    ? PLACEHOLDER
    : universeTickers && universeTickers.length > 0
      ? universeTickers.join(', ')
      : 'No universe connected'

  return (
    <div className="dscard">
      <div className="dscard__head">
        <CategoryIcon category="data" className="snode__icon" />
        <span className="dscard__title">{displayName}</span>
        <ValidityBadge validity={validity} />
      </div>

      <Row label="Source">
        {!resolvable ? (
          PLACEHOLDER
        ) : datasetId !== undefined ? (
          <span className="dscard__source">
            <span className="dscard__kind">Uploaded dataset</span>{' '}
            <code>{abbrev(datasetId)}</code>
          </span>
        ) : (
          'No dataset selected — choose in the strategy bar'
        )}
      </Row>

      {/* The connector frame reserves future kinds so the card reads as a trading-bot data source. */}
      <div className="dscard__connectors">Data API · Broker feed — future</div>

      <Row label="Universe">{universeRow}</Row>

      {resolvable && datasetMeta !== undefined ? (
        <>
          <Row label="Calendar">
            <span>
              {datasetMeta.first_session} → {datasetMeta.last_session}{' '}
              <span className="dscard__muted">({datasetMeta.sessions} sessions)</span>
            </span>
          </Row>
          <Row label="Fingerprint">
            <code>{abbrev(datasetMeta.dataset_fingerprint)}</code>
          </Row>
        </>
      ) : null}
    </div>
  )
}
