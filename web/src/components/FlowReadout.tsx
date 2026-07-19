// The flow readout (M14.3): the ONE-LINE digest the canvas edge-hover renders for a served node value.
// This module ships ONLY the pure projection — `NodeValueResponse['value_summary']` (the served
// discriminated union) → a token list; the React component that lays the tokens out and pairs them with
// `verbatimTitle` arrives in a later task. PRESENTATION ONLY: the projection reads served fields and
// formats each served number through the shared `fmtValue` — it never sums, ranks, sorts, or compares
// across values (CLAUDE.md invariant 5); the switch mirrors how `Inspector.tsx`'s `ValueSummary` narrows
// the same union on `.kind`.
import { Fragment, useEffect, useState, type ReactElement } from 'react'
import type { NodeValueResponse } from '@quantize/quantize-api'
import { errorMessage, getNodeValue } from '../api/client'
import { noEvaluationLine } from '../document/schedule'
import { abbrev, fmtValue, verbatimTitle } from '../format'

/** One fragment of the flow readout's digest line. `value` is present IFF the token displays a
 *  potentially-lossy number (an fmtValue-formatted served float) — the caller pairs it with
 *  `verbatimTitle` so the raw served number stays one hover away (D-27). Integer counts embed in
 *  prose tokens as `String(count)`: lossless by construction (asserted in tests). */
export interface DigestToken {
  text: string
  value?: number
}

// The verbatim-number rule made concrete: a served FLOAT gets its own token — `fmtValue` for display,
// the raw number carried in `value` so the exact figure is never lost, only one hover away (D-27). This
// is the ONLY constructor that sets `value`; every other token is lossless prose (String counts, labels,
// dates, boolean/asset-set text) and omits the key entirely (exactOptionalPropertyTypes: never `undefined`).
function numberToken(value: number): DigestToken {
  return { text: fmtValue(value), value }
}

// A render guard for a wide asset set: show the first few members, then an ellipsis so the one-line digest
// can never blow out. Not a comparison — no ordering or selection logic, just a display cap on served order.
const MEMBERS_SHOWN = 4

/** Project a served `value_summary` into the digest's display tokens. Exhaustive on `kind`; each branch
 *  reads only served fields, so an integer count renders as `String(count)` inside prose (lossless) while
 *  every served float becomes its own lossy value token. */
export function flowDigest(summary: NodeValueResponse['value_summary']): DigestToken[] {
  switch (summary.kind) {
    case 'scalar': {
      // The scalar VALUE is a served number only for Number/Integer dtypes; a Boolean displays verbatim
      // ('true'/'false') and is never lossy, so it carries no `value`.
      const valueToken: DigestToken =
        typeof summary.value === 'number' ? numberToken(summary.value) : { text: fmtValue(summary.value) }
      return [{ text: summary.dtype }, valueToken]
    }
    case 'asset_set': {
      // `count` (an integer) as prose; the members list capped for the one-line digest (server order).
      // An EMPTY set (a valid outcome — e.g. no selection survived) gets no members token at all:
      // emitting one would render a dangling ` · ` separator after the count.
      if (summary.members.length === 0) return [{ text: `${summary.count} members` }]
      const shown = summary.members.slice(0, MEMBERS_SHOWN)
      const membersText =
        summary.members.length > MEMBERS_SHOWN ? `${shown.join(', ')}…` : shown.join(', ')
      return [{ text: `${summary.count} members` }, { text: membersText }]
    }
    case 'cross_section': {
      // present/domain are integer counts → prose. A Number cross-section adds min/max (each a served
      // float → its own value token) when the server sent them; a Boolean adds the integer true/false
      // counts as prose. Absent (null) stats contribute no token at all.
      const tokens: DigestToken[] = [{ text: `${summary.present_count} of ${summary.domain_count} assets` }]
      if (summary.dtype === 'Number') {
        if (summary.min != null) tokens.push({ text: 'min' }, numberToken(summary.min))
        if (summary.max != null) tokens.push({ text: 'max' }, numberToken(summary.max))
      } else {
        if (summary.true_count != null) tokens.push({ text: `${summary.true_count} true` })
        if (summary.false_count != null) tokens.push({ text: `${summary.false_count} false` })
      }
      return tokens
    }
    case 'time_series': {
      // asset_count and total_points are integer counts → prose; the window (when present) is one token.
      const tokens: DigestToken[] = [
        { text: `${summary.asset_count} assets` },
        { text: `${summary.total_points} points` },
      ]
      if (summary.window != null) {
        tokens.push({ text: `${summary.window.first_date} → ${summary.window.last_date}` })
      }
      return tokens
    }
    case 'portfolio_targets':
      // The target count is an integer → prose; weight_sum and cash are served floats → labelled value tokens.
      return [
        { text: `${summary.count} targets` },
        { text: 'weights' },
        numberToken(summary.weight_sum),
        { text: 'cash' },
        numberToken(summary.cash),
      ]
  }
}

// ── The FlowReadout component: a dwell-gated, generation-tagged, UNCACHED value readout ──────────────
//
// The canvas edge-hover renders THIS: for the value carried on an edge's SOURCE end, at the run's
// session cursor, the one-line digest above (recompute-on-demand, GET /v1/runs/{id}/values). Its whole
// discipline is a RESULT LIFETIME: a served value belongs to the EXACT activation that requested it, so
// a value fetched for address A (or probe P) can never render for A' (or P') — not even for a single
// frame — and re-hovering the SAME address RECOMPUTES rather than reusing a prior result (§10.5: the
// tap is a fresh recompute, never a cache; a stale frame would misattribute one edge's value to another).

/** How long the pointer must dwell on an edge before the value fetch fires (module constant so the
 *  test drives the exact boundary). A hover that merely sweeps across edges never fetches. */
export const HOVER_DWELL_MS = 200

/** The run-side half of a readout request: which run, which session cursor, and whether that session
 *  actually evaluated (a non-evaluated session has no value to serve — the readout shows the honest
 *  no-eval line and never fetches). `scheduleKind` phrases that line (undefined ⇒ neutral wording). */
export interface FlowProbe {
  runId: string
  cursor: string
  evaluated: boolean
  scheduleKind: string | undefined
}

/** The edge-side half: the value-tap address an edge's SOURCE end carries (from `edgeAddress`), plus the
 *  human `sourceLabel` the client already holds — it prefixes a refusal (FD-6a) and titles the value. */
export interface FlowAddress {
  nodeId: string
  componentPath: string[]
  outputPort: string
  sourceLabel: string
}

// The stored resolution of ONE activation. It carries its own `gen`+`tag` so the render can reject it
// the instant the activation moves on (see the render guard below): a stored result is shown ONLY while
// it still matches the CURRENT activation. Success and refusal share the envelope so both are lifetime-
// bound identically (a stale refusal must not flash any more than a stale value).
type StoredResult =
  | { gen: number; tag: string; response: NodeValueResponse }
  | { gen: number; tag: string; error: string }

// The activation TAG: two hovers are the same activation IFF every addressing field matches. `evaluated`
// and `scheduleKind` are deliberately EXCLUDED — they gate whether to fetch, not WHICH value is fetched,
// so they never change a tag. A null address collapses to the sentinel '∅' (nothing hovered).
function activationTag(probe: FlowProbe, address: FlowAddress | null): string {
  if (address === null) return '∅'
  return `${probe.runId}|${probe.cursor}|${address.componentPath.join('/')}|${address.nodeId}|${address.outputPort}`
}

/**
 * The flow readout. Renders `null` when nothing is hovered; otherwise a `flow-readout` block that dwell-
 * fetches the served value and shows its digest, a refusal, or (for a non-evaluated session) the no-eval
 * line. `pinned` adds an "Esc to release" hint (the caller owns the pin/Esc wiring; this only renders it).
 */
export function FlowReadout({
  probe,
  address,
  pinned,
}: {
  probe: FlowProbe
  address: FlowAddress | null
  pinned: boolean
}): ReactElement | null {
  const currentTag = activationTag(probe, address)

  // The GENERATION tracker (the Canvas.tsx:442 `prevViewKey` pattern): a state-backed, RENDER-PHASE
  // reset. When the activation changes — including A → ∅ → A (leave + re-hover of the same address) —
  // we bump `gen` DURING render, so React re-renders with the new gen BEFORE committing. That is what
  // makes a stale result impossible to show even once: in the very commit where the activation flips,
  // `gen` has already advanced past any result stored under the old gen.
  //
  // It is STATE, never a render-mutated ref: under StrictMode an update render is REPLAYED, and a ref
  // mutation would persist across the replay (marking the change "handled") while the paired state work
  // is discarded — the two desync (this repo learned that the hard way in M13.8 round 7). State is
  // discarded/replayed together, so the tracker and the stored result stay consistent. It is not an
  // effect either: an effect runs AFTER commit, which would leak exactly the one stale frame we forbid.
  const [tracker, setTracker] = useState({ key: currentTag, gen: 0 })
  if (tracker.key !== currentTag) {
    setTracker({ key: currentTag, gen: tracker.gen + 1 })
  }

  const [stored, setStored] = useState<StoredResult | undefined>(undefined)

  // The dwell timer, in ONE effect keyed on the GENERATION. Because the tag (hence the gen) subsumes
  // every addressing field, keying on `tracker.gen` alone re-arms the dwell for exactly the activations
  // that need a new request. The effect CAPTURES this generation's gen+tag; the cleanup both cancels the
  // pending timer (a hover that leaves before the dwell never fetches) and marks the in-flight request
  // stale via `cancelled` — the store guard that implements "keep the result ONLY if its captured gen is
  // still current" WITHOUT a live gen ref (which would reintroduce the M13.8 ref-desync hazard): the
  // effect is torn down precisely when the generation advances, so `cancelled` ⇔ "this gen is no longer
  // current". A late resolution from a superseded activation is therefore dropped, never stored.
  useEffect(() => {
    if (address === null || !probe.evaluated) return
    const launchGen = tracker.gen
    const launchTag = currentTag
    let cancelled = false
    const timer = setTimeout(() => {
      // componentPath is passed ALWAYS (the client itself omits it from the query when empty); the port
      // always. A fresh call every dwell — never a lookup into a prior result (§10.5: no cache).
      getNodeValue(probe.runId, {
        nodeId: address.nodeId,
        sessionDate: probe.cursor,
        componentPath: address.componentPath,
        outputPort: address.outputPort,
      }).then(
        (response) => {
          if (!cancelled) setStored({ gen: launchGen, tag: launchTag, response })
        },
        (err: unknown) => {
          if (!cancelled) setStored({ gen: launchGen, tag: launchTag, error: errorMessage(err) })
        },
      )
    }, HOVER_DWELL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the generation IS the activation key: it
    // changes iff any fetched-address field (runId, cursor, componentPath, nodeId, outputPort) changes,
    // so re-running on `tracker.gen` alone re-arms the dwell exactly when the request must change.
    // COUPLING (spec review, Task 3): `probe.evaluated` is deliberately NOT in the key, so an
    // evaluated flip under a byte-identical (runId, cursor) would neither re-arm nor cancel this
    // effect. That transition is unreachable today because useDebugLoopState routes the cursor
    // through null on every run change and commits record + default cursor together — a wiring that
    // refetches a record IN PLACE under a fixed (runId, cursor) would reintroduce the gap here.
  }, [tracker.gen])

  // Nothing hovered → render nothing at all (and, above, never fetch).
  if (address === null) return null

  // The pin hint is pure presentation (Esc handling lives with the caller). Rendered alongside every
  // non-null-address body. The root modifier carries the pinned state for the CSS accent-border
  // convention (the `.rpanel__row.is-selected` precedent).
  const hint = pinned ? <span className="flow-readout__hint">Esc to release</span> : null
  const rootClass = pinned ? 'flow-readout flow-readout--pinned' : 'flow-readout'

  // A non-evaluated session has no served value — the honest shared no-eval line stands in its place.
  if (!probe.evaluated) {
    return (
      <div className={rootClass}>
        <p className="flow-readout__no-eval">{noEvaluationLine(probe.scheduleKind)}</p>
        {hint}
      </div>
    )
  }

  // The RENDER guard: a stored result may render ONLY while it still matches the current activation
  // (same generation AND same tag). Any mismatch — the address left, the probe moved, a re-hover bumped
  // the gen — falls through to the dwell placeholder, so a superseded value is never shown even once.
  // The `stored`-narrowing lives in the condition itself (not a captured boolean) so the union
  // discriminates: inside the block `'error' in stored` splits refusal from value.
  let body: ReactElement
  if (stored !== undefined && stored.gen === tracker.gen && stored.tag === currentTag) {
    if ('error' in stored) {
      // A SERVED refusal, verbatim, prefixed by the node's display label (FD-6a) — the reader sees which
      // edge was refused, never a bare hash. An alert so assistive tech announces the refusal.
      body = (
        <p className="flow-readout__error" role="alert">
          {address.sourceLabel} — {stored.error}
        </p>
      )
    } else {
      const { response } = stored
      body = (
        <>
          {/* Line 1: the source label · the SERVED output port (a defaulted/omitted port labels itself). */}
          <div className="flow-readout__head">
            {address.sourceLabel} · out {response.output_port}
          </div>
          {/* Line 2: the digest tokens, ` · `-separated. Each lossy value token pairs with `verbatimTitle`
              so the raw served float is one hover away; a lossless prose/count token gets NO title. */}
          <div className="flow-readout__digest">
            {flowDigest(response.value_summary).map((token, i) => (
              <Fragment key={i}>
                {i > 0 ? ' · ' : null}
                <span {...verbatimTitle(token.value)}>{token.text}</span>
              </Fragment>
            ))}
          </div>
          {/* Line 3: recompute provenance, matching the Inspector's ValueBlock phrasing — the abbreviated
              fingerprint for the narrow readout, the full 64-char hash reachable in `title` (PX-E). */}
          <p className="flow-readout__provenance">
            Recomputed on demand from the run's pinned inputs{' '}
            <code title={response.provenance.dataset_fingerprint}>
              {abbrev(response.provenance.dataset_fingerprint)}
            </code>
          </p>
        </>
      )
    }
  } else {
    // Dwelling (or the stored result is stale by the guard above): a minimal muted placeholder.
    body = <p className="flow-readout__loading">…</p>
  }

  return (
    <div className={rootClass}>
      {body}
      {hint}
    </div>
  )
}
