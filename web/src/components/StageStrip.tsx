// The pipeline stage strip (M13.4) — the single strongest "you are looking at a strategy machine"
// device. It renders the §3 narrative as fixed segments — Data → Transforms → Signals → Rank & Select
// → Weighting & Risk → Targets → ⟨Engine⟩ — over the FIXED category→segment rollup (a pure display
// grouping of served categories, never a re-derivation of stage semantics). Per-segment counts, a
// click-to-highlight callback, an appended "Advanced" bucket for unknown/reserved categories (never
// dropped), a "Components" chip for composite instances, and a visually distinct Engine segment that
// is drawn OUTSIDE the graph (invariant 2 — the engine is not a node).
import type { ReactElement } from 'react'
import { categoryColor } from '../catalog/colors'

/** The minimal per-node shape the strip needs: its served category + whether it is a component. */
export interface StageStripNode {
  id: string
  category?: string | undefined
  isComponent?: boolean | undefined
}

export interface StageStripProps {
  nodes: StageStripNode[]
  /** Highlight the segment's nodes on canvas (the App resolves the ids to a selection). */
  onSelectSegment?: (nodeIds: string[]) => void
  /** The engine chip links downstream (Results/Trace); optional so the strip renders standalone. */
  onEngineClick?: (() => void) | undefined
}

// The FIXED rollup (Contracts): each graph segment and the categories it absorbs. Order IS the machine
// narrative. `color` uses the segment's primary category token. The Engine segment is separate below.
const SEGMENTS: readonly { key: string; label: string; categories: readonly string[] }[] = [
  { key: 'data', label: 'Data', categories: ['universe', 'data'] },
  { key: 'transforms', label: 'Transforms', categories: ['transform'] },
  { key: 'signals', label: 'Signals', categories: ['signal'] },
  { key: 'rank', label: 'Rank & Select', categories: ['selection'] },
  { key: 'weighting', label: 'Weighting & Risk', categories: ['weighting', 'risk'] },
  { key: 'targets', label: 'Targets', categories: ['output'] },
]

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(SEGMENTS.flatMap((s) => s.categories))

// One clickable graph segment (or the Advanced bucket): colored by its primary category, showing the
// count, dispatching its node ids on click.
function Segment(props: {
  label: string
  color: string
  nodeIds: string[]
  onSelectSegment: ((nodeIds: string[]) => void) | undefined
}): ReactElement {
  const count = props.nodeIds.length
  return (
    <button
      type="button"
      className="stage__seg"
      style={{ ['--stage-color' as string]: props.color }}
      onClick={() => props.onSelectSegment?.(props.nodeIds)}
      aria-label={`${props.label}: ${count} node${count === 1 ? '' : 's'}`}
    >
      <span className="stage__seg-label">{props.label}</span>
      <span className="stage__seg-count">{count}</span>
    </button>
  )
}

export function StageStrip({ nodes, onSelectSegment, onEngineClick }: StageStripProps): ReactElement {
  const graphNodes = nodes.filter((n) => !n.isComponent)
  const componentCount = nodes.length - graphNodes.length

  // Bucket each graph node into its segment (by the rollup) or into "Advanced" when its category maps
  // to no segment — including an unknown/future/undefined category. Never silently dropped.
  const idsBySegment = new Map<string, string[]>(SEGMENTS.map((s) => [s.key, []]))
  const advancedIds: string[] = []
  for (const node of graphNodes) {
    const segment =
      node.category !== undefined
        ? SEGMENTS.find((s) => s.categories.includes(node.category as string))
        : undefined
    if (segment !== undefined && KNOWN_CATEGORIES.has(node.category as string)) {
      idsBySegment.get(segment.key)?.push(node.id)
    } else {
      advancedIds.push(node.id)
    }
  }

  return (
    <div className="stage" aria-label="pipeline stages">
      {SEGMENTS.map((segment, i) => (
        <div className="stage__cell" key={segment.key}>
          <Segment
            label={segment.label}
            color={categoryColor(segment.categories[0])}
            nodeIds={idsBySegment.get(segment.key) ?? []}
            onSelectSegment={onSelectSegment}
          />
          {i < SEGMENTS.length - 1 ? <span className="stage__arrow" aria-hidden="true">→</span> : null}
        </div>
      ))}

      {advancedIds.length > 0 ? (
        <div className="stage__cell">
          <span className="stage__arrow" aria-hidden="true">→</span>
          <Segment
            label="Advanced"
            color={categoryColor('__unknown__')}
            nodeIds={advancedIds}
            onSelectSegment={onSelectSegment}
          />
        </div>
      ) : null}

      {/* The engine is drawn OUTSIDE the graph (invariant 2): its own styling, no graph count. */}
      <div className="stage__cell">
        <span className="stage__arrow" aria-hidden="true">→</span>
        <button
          type="button"
          className="stage__seg stage__seg--engine"
          onClick={onEngineClick}
          aria-label="Engine — targets to orders to fills"
        >
          <span className="stage__seg-label">Engine</span>
          <span className="stage__seg-sub">targets → orders → fills</span>
        </button>
      </div>

      {componentCount > 0 ? (
        <div className="stage__cell stage__cell--components">
          <span className="stage__chip" aria-label={`Components: ${componentCount}`}>
            Components <span className="stage__seg-count">{componentCount}</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
