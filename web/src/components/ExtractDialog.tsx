// Component-extraction dialog + two-phase commit (M12.5, E5/E6).
//
// This is the highest-risk UX flow in the editor: it turns the App-owned extraction selection into a
// named, versioned `ComponentDefinition` and REWRITES the strategy to reference it. The safety contract
// (E5) is a TWO-PHASE COMMIT against server authority: the document is NEVER replaced until the server
// blesses the rewrite. The order is strict:
//   1. `extractComponent` in memory (pure; on {error} → abort, doc untouched)
//   2. `saveComponent(definition)`  (ApiClientError → abort, doc untouched)
//   3. `validateStrategy(strategy)` (ok:false → render diagnostics, abort, doc untouched)
//   4. ONLY on ok:true → `onReplace(strategy)` + cache `seed(definition)` + `onExtracted(newNodeId)`
// Any failure leaves `doc` exactly as it was — the parent never sees a mutation on an abort path.
//
// Client pre-checks are STRUCTURAL only (E6): `extractComponent` enforces non-empty + weak connectivity,
// and exposed-port NAMES are constrained to `^[A-Za-z0-9_]+$` here (they become instance port names used
// in edges). Everything semantic (terminal presence, required-input coverage, recursion) is the server's
// job — that is exactly why the commit runs validate before touching the document. No numerical,
// portfolio, or type-compatibility logic lives here (CLAUDE.md invariant 5); no domain type is
// re-declared (invariant 4) — the definition/strategy are the generated IR types.
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError, errorMessage, saveComponent, validateStrategy } from '../api/client'
import { labelOf, nodeTypeById, useCatalog } from '../catalog'
import type { PortType } from '../catalog'
import { useComponentDefs } from '../components-cache'
import { extractComponent } from '../document/extract'
import type { ExposedParamRequest } from '../document/extract'

/** The exposed-port name grammar (E6): an instance port name used in edges — must be an identifier. */
const IDENTIFIER = /^[A-Za-z0-9_]+$/

export interface ExtractDialogProps {
  /** The current (pre-extraction) document — READ ONLY here; only ever mutated via `onReplace`. */
  doc: StrategyDocument
  /** The App-owned extraction selection (the subgraph to extract). */
  selection: ReadonlySet<string>
  /** Commit the rewritten strategy (the ONLY document-mutation path — fired on server `ok:true`). */
  onReplace: (doc: StrategyDocument) => void
  /** Close the dialog without touching anything. */
  onCancel: () => void
  /** Fire on a successful commit with the minted instance node's id (App refreshes/exits/selects). */
  onExtracted: (newNodeId: string) => void
}

/** One exposable parameter row: `paramKey` on `nodeId` (shown under the node's display label). */
interface ParamOption {
  nodeId: string
  nodeLabel: string
  paramKey: string
}

/** One previewed exposed port: its computed default name + type + direction. */
interface PreviewPort {
  name: string
  type: PortType
  direction: 'input' | 'output'
}

/** A stable key for a param row's local UI state (checkbox + exposed-name draft). */
function paramKeyOf(nodeId: string, paramKey: string): string {
  return `${nodeId}::${paramKey}`
}

export function ExtractDialog({
  doc,
  selection,
  onReplace,
  onCancel,
  onExtracted,
}: ExtractDialogProps): ReactElement {
  const { catalog } = useCatalog()
  const { defs, get, seed } = useComponentDefs()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // Exposed-port name overrides, keyed by the port's computed DEFAULT name (the collision-suffixed name
  // `extractComponent` mints deterministically). A shown value = `portEdits[default] ?? default`.
  const [portEdits, setPortEdits] = useState<Record<string, string>>({})
  const [paramChecks, setParamChecks] = useState<Record<string, boolean>>({})
  const [paramNames, setParamNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | undefined>(undefined)
  const [diagnostics, setDiagnostics] = useState<ValidateResponse | undefined>(undefined)

  // A DRY-RUN extraction with a placeholder name computes the deduped exposed ports (names + types are
  // deterministic — minted ids are irrelevant to the preview). It also surfaces a structural pre-check
  // failure (empty/disconnected) as `previewError`, which disables Confirm before any network call.
  const preview = useMemo(() => {
    if (catalog === undefined) {
      return undefined
    }
    return extractComponent(doc, selection, catalog, defs, { name: 'preview', exposedParams: [] })
  }, [catalog, doc, selection, defs])
  const previewError = preview !== undefined && 'error' in preview ? preview.error : undefined
  const previewPorts: PreviewPort[] =
    preview !== undefined && !('error' in preview)
      ? [
          ...preview.definition.exposed_inputs.map(
            (p): PreviewPort => ({ name: p.name, type: p.type, direction: 'input' }),
          ),
          ...preview.definition.exposed_outputs.map(
            (p): PreviewPort => ({ name: p.name, type: p.type, direction: 'output' }),
          ),
        ]
      : []

  // The parameters the user may opt to expose: every parameter of every selected node. Registered nodes
  // enumerate from the catalog's `parameter_schema`; a nested component instance enumerates its cached
  // definition's `exposed_params` (extractComponent copies the schema fragment verbatim on commit).
  const paramOptions: ParamOption[] = useMemo(() => {
    if (catalog === undefined) {
      return []
    }
    const options: ParamOption[] = []
    for (const node of doc.nodes) {
      if (!selection.has(node.id)) {
        continue
      }
      if ('ref' in node) {
        const ref = doc.component_refs.find((r) => r.id === node.ref)
        const def = ref === undefined ? undefined : get(ref.component_id, ref.version)
        const label = def?.name ?? node.id
        for (const p of def?.exposed_params ?? []) {
          options.push({ nodeId: node.id, nodeLabel: label, paramKey: p.name })
        }
      } else {
        const nodeType = nodeTypeById(catalog, node.type_id)
        const label = nodeType?.display_name ?? node.type_id
        const properties = nodeType?.parameter_schema?.properties
        if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
          for (const key of Object.keys(properties ?? {})) {
            options.push({ nodeId: node.id, nodeLabel: label, paramKey: key })
          }
        }
      }
    }
    return options
  }, [catalog, doc, selection, get])

  // Every previewed port's effective name must be a valid identifier before Confirm is allowed (E6).
  const portsValid = previewPorts.every((p) => IDENTIFIER.test(portEdits[p.name] ?? p.name))
  const confirmDisabled =
    busy ||
    catalog === undefined ||
    previewError !== undefined ||
    name.trim() === '' ||
    !portsValid

  const onConfirm = async (): Promise<void> => {
    if (catalog === undefined) {
      return
    }
    setErrorText(undefined)
    setDiagnostics(undefined)

    // Build the override map ONLY for renamed ports — passing an override equal to the default would
    // collide with the default name `extractComponent` already reserved.
    const portNames = new Map<string, string>()
    for (const port of previewPorts) {
      const effective = portEdits[port.name] ?? port.name
      if (effective !== port.name) {
        portNames.set(port.name, effective)
      }
    }
    const exposedParams: ExposedParamRequest[] = paramOptions
      .filter((o) => paramChecks[paramKeyOf(o.nodeId, o.paramKey)])
      .map((o) => ({
        nodeId: o.nodeId,
        paramKey: o.paramKey,
        exposedName: paramNames[paramKeyOf(o.nodeId, o.paramKey)] ?? o.paramKey,
      }))

    // Phase 1: pure in-memory extraction. On any structural/data failure → abort, doc untouched.
    // `description` is omitted (not set to `undefined`) when blank — the IR field is optional.
    const trimmedDescription = description.trim()
    const result = extractComponent(doc, selection, catalog, defs, {
      name: name.trim(),
      ...(trimmedDescription !== '' ? { description: trimmedDescription } : {}),
      exposedParams,
      portNames,
    })
    if ('error' in result) {
      setErrorText(result.error)
      return
    }

    setBusy(true)
    // Phase 2: persist the component. A failure (409 divergent / 422 invalid / network) → abort.
    try {
      await saveComponent(result.definition)
    } catch (e) {
      setBusy(false)
      setErrorText(e instanceof ApiClientError ? `${e.code}: ${e.message}` : errorMessage(e))
      return
    }

    // Phase 3: run-faithful validation of the REWRITTEN strategy against server authority.
    let verdict: ValidateResponse
    try {
      verdict = await validateStrategy(result.strategy)
    } catch (e) {
      setBusy(false)
      setErrorText(e instanceof ApiClientError ? `${e.code}: ${e.message}` : errorMessage(e))
      return
    }
    if (!verdict.ok) {
      // The server rejected the rewrite — render its diagnostics; the document is NEVER touched.
      setBusy(false)
      setDiagnostics(verdict)
      return
    }

    // Phase 4: the server blessed it — NOW (and only now) mutate the document + seed the cache.
    onReplace(result.strategy)
    seed(result.definition)
    const minted = result.strategy.nodes.find((n) => !doc.nodes.some((o) => o.id === n.id))
    onExtracted(minted?.id ?? '')
  }

  // Flatten server diagnostics to code+message rows, reusing the validate panel's presentation classes.
  const diagnosticRows =
    diagnostics !== undefined && !diagnostics.ok
      ? [
          ...diagnostics.structural.map((d) => ({ code: d.code, message: d.message })),
          ...diagnostics.semantic.map((d) => ({ code: d.code, message: d.message })),
          ...diagnostics.runtime.map((d) => ({ code: d.code, message: d.message })),
        ]
      : []

  return (
    <div
      className="xdialog"
      role="dialog"
      aria-label="create component"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel()
        }
      }}
      onClick={onCancel}
    >
      <div className="xdialog__panel" onClick={(e) => e.stopPropagation()}>
        <header className="xdialog__head">
          <div className="xdialog__title">Create component</div>
          <button type="button" className="xdialog__close" onClick={onCancel} aria-label="close">
            ×
          </button>
        </header>

        <div className="xdialog__body">
          <label className="xdialog__field">
            <span className="xdialog__label">Name</span>
            <input
              className="xdialog__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="component name"
            />
          </label>
          <label className="xdialog__field">
            <span className="xdialog__label">Description (optional)</span>
            <textarea
              className="xdialog__input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="component description"
            />
          </label>

          <section className="xdialog__section">
            <h4 className="xdialog__section-title">Exposed ports</h4>
            {catalog === undefined ? (
              <p className="xdialog__hint">Loading node catalog…</p>
            ) : previewError !== undefined ? (
              <p className="xdialog__hint xdialog__hint--error">{previewError}</p>
            ) : previewPorts.length === 0 ? (
              <p className="xdialog__hint">No ports crossed the selection boundary.</p>
            ) : (
              <ul className="xdialog__ports">
                {previewPorts.map((port) => {
                  const effective = portEdits[port.name] ?? port.name
                  const valid = IDENTIFIER.test(effective)
                  return (
                    <li key={`${port.direction}:${port.name}`} className="xdialog__port">
                      <span className="xdialog__port-dir">{port.direction}</span>
                      <input
                        className="xdialog__input"
                        value={effective}
                        aria-label={`port name ${port.name}`}
                        onChange={(e) =>
                          setPortEdits((s) => ({ ...s, [port.name]: e.target.value }))
                        }
                      />
                      <span className="xdialog__port-type">{labelOf(catalog, port.type)}</span>
                      {!valid ? (
                        <span className="xdialog__port-err">must be a valid identifier</span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="xdialog__section">
            <h4 className="xdialog__section-title">Exposed parameters</h4>
            {paramOptions.length === 0 ? (
              <p className="xdialog__hint">No parameters to expose.</p>
            ) : (
              <ul className="xdialog__params">
                {paramOptions.map((o) => {
                  const key = paramKeyOf(o.nodeId, o.paramKey)
                  const checked = paramChecks[key] ?? false
                  return (
                    <li key={key} className="xdialog__param">
                      <label className="xdialog__param-label">
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`expose ${key}`}
                          onChange={(e) =>
                            setParamChecks((s) => ({ ...s, [key]: e.target.checked }))
                          }
                        />
                        <span>
                          {o.nodeLabel} · {o.paramKey}
                        </span>
                      </label>
                      {checked ? (
                        <input
                          className="xdialog__input"
                          value={paramNames[key] ?? o.paramKey}
                          aria-label={`exposed name ${key}`}
                          onChange={(e) => setParamNames((s) => ({ ...s, [key]: e.target.value }))}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {errorText !== undefined ? (
            <div className="xdialog__error" role="alert">
              {errorText}
            </div>
          ) : null}

          {diagnosticRows.length > 0 ? (
            <div className="xdialog__diags" role="alert">
              <p className="xdialog__diags-title">The server rejected the rewrite:</p>
              <ul className="xdialog__diag-list">
                {diagnosticRows.map((row, i) => (
                  <li key={`${row.code}:${i}`} className="vpanel__diag">
                    <span className="vpanel__diag-code">{row.code}</span>
                    <span className="vpanel__diag-msg">{row.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="xdialog__foot">
          <button
            type="button"
            className="pform__btn pform__btn--primary"
            disabled={confirmDisabled}
            onClick={() => void onConfirm()}
          >
            {busy ? 'Creating…' : 'Create component'}
          </button>
          <button type="button" className="pform__btn" onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  )
}
