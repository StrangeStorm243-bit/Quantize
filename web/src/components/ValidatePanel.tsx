// Run-faithful validation panel (M11.5, D6).
//
// A "Validate" button POSTs the document to `/v1/strategies/validate` and renders the per-layer
// diagnostics. A semantically-invalid document is NORMAL editing state: the endpoint returns HTTP
// 200 with `ok:false` and the diagnostics to render — it is NOT an error. Only a request-level
// failure (400 parse / 422 version) throws an `ApiClientError`, shown distinctly.
//
// HIGHLIGHTING IS STRUCTURED — we NEVER parse a message. A diagnostic maps to a target purely from
// its `loc` / `node_path`: `loc[0]==="nodes"` → the node at that index; `loc[0]==="edges"` → the
// edge at that index; runtime `node_path[0]` → the node with that id. The App resolves the target to
// a selection / edge highlight.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  RuntimeDiagnosticDto,
  SemanticDiagnosticDto,
  StructuralDiagnosticDto,
  ValidateResponse,
} from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError, validateStrategy } from '../api/client'

/**
 * A structured highlight target computed from a diagnostic's location — never from its message.
 * `nodeIndex`/`edgeIndex` come from a `loc` path (structural/semantic); `nodeId` from a runtime
 * `node_path[0]`. The App resolves an index against the current document to pick the entity.
 */
export type HighlightTarget =
  | { kind: 'nodeIndex'; index: number }
  | { kind: 'edgeIndex'; index: number }
  | { kind: 'nodeId'; nodeId: string }

/** Target for a `loc`-located diagnostic (structural/semantic): `("nodes"|"edges", index, ...)`. */
export function locTarget(loc: (string | number)[]): HighlightTarget | undefined {
  if (loc.length >= 2 && typeof loc[1] === 'number') {
    if (loc[0] === 'nodes') {
      return { kind: 'nodeIndex', index: loc[1] }
    }
    if (loc[0] === 'edges') {
      return { kind: 'edgeIndex', index: loc[1] }
    }
  }
  return undefined
}

/** Target for a runtime diagnostic: the top of its execution `node_path` is a node id. */
export function nodePathTarget(nodePath: string[]): HighlightTarget | undefined {
  return nodePath.length > 0 ? { kind: 'nodeId', nodeId: nodePath[0] } : undefined
}

export interface ValidatePanelProps {
  doc: StrategyDocument
  onHighlight: (target: HighlightTarget) => void
}

// One clickable diagnostic row: code + message + subject, clicking dispatches the computed target.
function DiagnosticRow(props: {
  code: string
  message: string
  subject: string | null | undefined
  target: HighlightTarget | undefined
  onHighlight: (target: HighlightTarget) => void
}): ReactElement {
  const { code, message, subject, target, onHighlight } = props
  return (
    <li className="vpanel__diag">
      <button
        type="button"
        className="vpanel__diag-btn"
        disabled={target === undefined}
        onClick={() => {
          if (target !== undefined) {
            onHighlight(target)
          }
        }}
      >
        <span className="vpanel__diag-code">{code}</span>
        <span className="vpanel__diag-msg">{message}</span>
        {subject !== null && subject !== undefined ? (
          <span className="vpanel__diag-subject">{subject}</span>
        ) : null}
      </button>
    </li>
  )
}

export function ValidatePanel({ doc, onHighlight }: ValidatePanelProps): ReactElement {
  const [result, setResult] = useState<ValidateResponse | undefined>(undefined)
  const [error, setError] = useState<{ code: string; message: string } | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  // Diagnostics carry POSITIONAL highlight targets (`loc`/`node_path` resolved by array index into
  // the current `doc.nodes`/`doc.edges`). Once the validated document changes — a node/edge is added,
  // removed, or reordered — those indices point at different entities, so a stale result would
  // mis-highlight. Discard the last verdict (and any request error) whenever `doc` changes; the user
  // re-validates the new document to get fresh, correctly-indexed diagnostics.
  useEffect(() => {
    setResult(undefined)
    setError(undefined)
  }, [doc])

  const onValidate = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const verdict = await validateStrategy(doc)
      setResult(verdict)
    } catch (e) {
      // A request-level failure is not a diagnostic. An ApiClientError (400 parse / 422 version)
      // carries the stable envelope code+message. Anything else (e.g. a raw network `TypeError`) is
      // surfaced the same way rather than re-thrown into the voided promise as an unhandled rejection.
      setResult(undefined)
      if (e instanceof ApiClientError) {
        setError({ code: e.code, message: e.message })
      } else {
        setError({ code: 'unexpected_error', message: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="vpanel">
      <div className="vpanel__bar">
        <button type="button" className="pform__btn" onClick={() => void onValidate()} disabled={loading}>
          {loading ? 'Validating…' : 'Validate'}
        </button>
      </div>

      {error !== undefined ? (
        <div className="vpanel__request-error" role="alert">
          <span className="vpanel__diag-code">{error.code}</span>
          <span className="vpanel__diag-msg">{error.message}</span>
        </div>
      ) : null}

      {error === undefined && result !== undefined ? (
        result.ok ? (
          <div className="vpanel__ok">
            <strong>Valid.</strong>{' '}
            {typeof result.warmup_sessions === 'number' ? (
              <span>Warm-up: {result.warmup_sessions} sessions.</span>
            ) : null}
          </div>
        ) : (
          <div className="vpanel__diags">
            <DiagnosticList
              title="Structural"
              items={result.structural}
              toRow={(d: StructuralDiagnosticDto) => ({
                code: d.code,
                message: d.message,
                subject: d.subject,
                target: locTarget(d.loc),
              })}
              onHighlight={onHighlight}
            />
            <DiagnosticList
              title="Semantic"
              items={result.semantic}
              toRow={(d: SemanticDiagnosticDto) => ({
                code: d.code,
                message: d.message,
                subject: d.subject,
                target: locTarget(d.loc),
              })}
              onHighlight={onHighlight}
            />
            <DiagnosticList
              title="Runtime"
              items={result.runtime}
              toRow={(d: RuntimeDiagnosticDto) => ({
                code: d.code,
                message: d.message,
                subject: d.subject,
                target: nodePathTarget(d.node_path),
              })}
              onHighlight={onHighlight}
            />
          </div>
        )
      ) : null}
    </div>
  )
}

// One labelled layer list. Empty layers still render a header so the reader sees all three checked.
function DiagnosticList<T>(props: {
  title: string
  items: T[]
  toRow: (item: T) => {
    code: string
    message: string
    subject: string | null | undefined
    target: HighlightTarget | undefined
  }
  onHighlight: (target: HighlightTarget) => void
}): ReactElement {
  const { title, items, toRow, onHighlight } = props
  return (
    <section className="vpanel__layer">
      <h4 className="vpanel__layer-title">
        {title} ({items.length})
      </h4>
      {items.length > 0 ? (
        <ul className="vpanel__diag-list">
          {items.map((item, i) => {
            const row = toRow(item)
            return (
              <DiagnosticRow
                key={`${row.code}:${i}`}
                code={row.code}
                message={row.message}
                subject={row.subject}
                target={row.target}
                onHighlight={onHighlight}
              />
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
