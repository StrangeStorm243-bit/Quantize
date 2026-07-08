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
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  RuntimeDiagnosticDto,
  SemanticDiagnosticDto,
  StructuralDiagnosticDto,
  ValidateResponse,
} from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError, validateStrategy } from '../api/client'
import { semanticKey } from '../document/store'
import { locTarget, nodePathTarget } from '../validation/targets'
import type { HighlightTarget } from '../validation/targets'

export interface ValidatePanelProps {
  doc: StrategyDocument
  onHighlight: (target: HighlightTarget) => void
  /**
   * A monotonic nonce (M13.3): the strategy bar's "Validate" verb bumps it to trigger a validation from
   * outside the panel (in addition to the panel's own button). Undefined/0 = no external trigger.
   *
   * CONSUMPTION IS APP-OWNED (M13.4): the dock mounts only the active panel, so a positive nonce that
   * lingers in App state would REPLAY on every remount (dock navigation) — and, because the real dev
   * entry wraps the app in StrictMode, the mount effect runs twice per mount. The panel keeps NO
   * consumption state of its own (it is lost on remount, and an async App reset does not land between
   * StrictMode's two synchronous invocations). Instead it asks the App's SYNCHRONOUS guard
   * {@link ValidatePanelProps.consumeValidateNonce}, which returns true only the first time a nonce is
   * seen — so one Validate click issues exactly one request.
   */
  validateNonce?: number
  /** App-owned synchronous guard: true iff this nonce is newly consumed (first caller wins). */
  consumeValidateNonce?: (nonce: number) => boolean
  /**
   * Mirror the LATEST verdict up to the App (M13.4) so node cards can badge validity (D-7). Called
   * with the response on validate, and with `undefined` when the verdict is cleared (a doc change or
   * a request error) — so a badge is never a stale green.
   */
  onResult?: (result: ValidateResponse | undefined) => void
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

export function ValidatePanel({
  doc,
  onHighlight,
  validateNonce,
  consumeValidateNonce,
  onResult,
}: ValidatePanelProps): ReactElement {
  const [result, setResult] = useState<ValidateResponse | undefined>(undefined)
  const [error, setError] = useState<{ code: string; message: string } | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  // The document's SEMANTIC identity (ui.* excluded). The validity lifecycle keys on THIS, not the
  // whole `doc` object: a pure node move (ui.position) must not clear a valid verdict, and an
  // in-flight request must be discarded only when the semantics actually changed.
  const key = useMemo(() => semanticKey(doc), [doc])
  // The latest committed key, read at async-resolve time to detect a supersession.
  const latestKey = useRef(key)
  useEffect(() => {
    latestKey.current = key
  }, [key])
  // A strictly-increasing request ticket. Two SAME-KEY validations (both fired via `validateNonce`,
  // which is not gated by `loading`) share a key, so the key check alone cannot tell them apart — the
  // slower earlier one could clobber the newer result or clear the spinner while the newer is still
  // pending. Each request captures its ticket; a response may publish ONLY if it holds the latest one.
  const latestTicket = useRef(0)

  // Diagnostics carry POSITIONAL highlight targets (`loc`/`node_path` resolved by array index into
  // the current `doc.nodes`/`doc.edges`). Once the document's SEMANTICS change — a node/edge added,
  // removed, reordered, or a param edited — those indices point at different entities, so a stale
  // result would mis-highlight (and re-badge). Discard the last verdict (and any request error)
  // whenever the semantic key changes; a pure ui move (same key) keeps the verdict (D-7).
  useEffect(() => {
    // PANEL-LOCAL display reset only. We deliberately do NOT clear the App's mirrored verdict here:
    // the dock mounts only the active panel, so switching tabs unmounts/remounts this panel with the
    // SAME semantic key, and a mount-time `onResult(undefined)` would wipe node badges on mere
    // navigation (not a semantic mutation) — violating D-7. The App owns clearing its verdict on a real
    // semantic change (App `useEffect([docKey])`); `computeNodeValidity` also gates on key match, so a
    // lingering verdict never renders a stale green.
    setResult(undefined)
    setError(undefined)
    // Also clear the spinner: any request in flight when the key changed is now stale — its `finally`
    // guard (isCurrent) fails, so it will NEVER clear loading itself. Without this the panel would be
    // stuck in "Validating…" after a semantic edit lands mid-flight. No LEGITIMATE request loses its
    // spinner: a request started after this edit (the nonce effect below runs later in the commit)
    // re-sets loading=true.
    setLoading(false)
  }, [key])

  const onValidate = async (): Promise<void> => {
    // Capture this request's identity: the semantics it validates AND a monotonic ticket. A resolved
    // response may touch state ONLY if BOTH still hold — its key matches the current document (no
    // semantic edit landed) AND its ticket is still the latest (no newer same-key request was fired).
    // Either check failing means this response is stale and must publish nothing (prevents a stale
    // green and a slow older request clobbering a newer one).
    const requestKey = key
    const requestTicket = (latestTicket.current += 1)
    const isCurrent = (): boolean =>
      requestKey === latestKey.current && requestTicket === latestTicket.current
    setLoading(true)
    setError(undefined)
    try {
      const verdict = await validateStrategy(doc)
      if (!isCurrent()) {
        return // superseded by a semantic edit or a newer same-key request — discard entirely
      }
      setResult(verdict)
      onResult?.(verdict)
    } catch (e) {
      if (!isCurrent()) {
        return // stale request — do not surface its error against the newer document/request
      }
      // A request-level failure is not a diagnostic. An ApiClientError (400 parse / 422 version)
      // carries the stable envelope code+message. Anything else (e.g. a raw network `TypeError`) is
      // surfaced the same way rather than re-thrown into the voided promise as an unhandled rejection.
      setResult(undefined)
      onResult?.(undefined)
      if (e instanceof ApiClientError) {
        setError({ code: e.code, message: e.message })
      } else {
        setError({ code: 'unexpected_error', message: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      // Clear loading only if this request is still the current one; a superseded request must not
      // flip a newer validation's spinner while it is still pending.
      if (isCurrent()) {
        setLoading(false)
      }
    }
  }

  // External trigger (M13.3): the strategy bar's Validate verb bumps `validateNonce` to run a
  // validation from outside. The initial undefined/0 does not auto-validate; only a positive value
  // fires. We gate on the App's SYNCHRONOUS consume guard so a StrictMode double-invoked mount effect —
  // or a dock remount with an already-consumed nonce — runs at most one request. When no guard is
  // provided (unit tests), every positive nonce is treated as fresh.
  useEffect(() => {
    if (validateNonce === undefined || validateNonce <= 0) {
      return
    }
    if (consumeValidateNonce !== undefined && !consumeValidateNonce(validateNonce)) {
      return // already consumed (StrictMode's second invocation, or a dock remount) — inert
    }
    void onValidate()
    // onValidate closes over the current doc and is intentionally omitted (it changes every render).
  }, [validateNonce]) // eslint-disable-line react-hooks/exhaustive-deps

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
