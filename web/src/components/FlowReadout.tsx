// The flow readout (M14.3): the ONE-LINE digest the canvas edge-hover renders for a served node value.
// This module ships ONLY the pure projection — `NodeValueResponse['value_summary']` (the served
// discriminated union) → a token list; the React component that lays the tokens out and pairs them with
// `verbatimTitle` arrives in a later task. PRESENTATION ONLY: the projection reads served fields and
// formats each served number through the shared `fmtValue` — it never sums, ranks, sorts, or compares
// across values (CLAUDE.md invariant 5); the switch mirrors how `Inspector.tsx`'s `ValueSummary` narrows
// the same union on `.kind`.
import type { NodeValueResponse } from '@quantize/quantize-api'
import { fmtValue } from '../format'

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
