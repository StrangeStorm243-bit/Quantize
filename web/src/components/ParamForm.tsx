// Schema-driven parameter form (M11.5, D6).
//
// Renders ONE control per `properties` entry of a node type's `parameter_schema`, over the guarded
// 14-keyword subset the codegen allows (type/properties/required/additionalProperties/minimum/
// exclusiveMinimum/maximum/minLength/minItems/uniqueItems/items/oneOf/const/default). Constraints
// (`min`/`max`/`step`) are UX HINTS ONLY — there is NO client-side authoritative validation here
// (no ajv, no numerical/portfolio logic, CLAUDE.md invariant 5). The server's `/v1/strategies/validate`
// is the single authority; this form just edits values and emits them. Anything the subset can't
// render falls back to a raw-JSON textarea (the D6 escape hatch) so rich/future constructs still edit.
//
// Every change produces `{...params, [name]: value}` (or drops the key when cleared) and calls
// `onParamsChange` — the doc store's `setParams` reducer is the only thing that mutates the document.
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { JsonValue } from '@quantize/quantize-ir'
import type { ParamDocDto } from '@quantize/quantize-api'
import type { NodeParams } from '../document/store'

/** The `parameter_schema` shape as the catalog types it (an object of JSON Schema keywords, or null). */
export type ParameterSchema = { [k: string]: JsonValue } | null

export interface ParamFormProps {
  /** The node type's parameter schema (verbatim from the catalog). */
  schema: ParameterSchema
  /** The node's current params (the edit target). */
  params: NodeParams
  /** Per-parameter display docs (the catalog's `doc.parameters`); label falls back to the key. */
  docs?: { [k: string]: ParamDocDto }
  /** Emit the next params object (whole-object replace, exactly what `setParams` takes). */
  onParamsChange: (next: NodeParams) => void
}

// Narrow an opaque JsonValue to a plain object (not null, not an array) or undefined.
function asRecord(v: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : undefined
}

function asNumber(v: JsonValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/**
 * Parse a raw number-input string to a FINITE number, or `undefined` for empty / garbage / non-finite.
 * Rejecting non-finite (`NaN`, `Infinity`) is essential, not cosmetic: `JSON.stringify(Infinity)` is
 * the string `'null'`, so an un-guarded Infinity would silently corrupt to null on the wire. Shared by
 * NumberControl and the oneOf number branch so both guard identically.
 */
export function parseFiniteNumber(raw: string): number | undefined {
  if (raw === '') {
    return undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// Build the next params: set the key, or DELETE it when the value is undefined (a cleared optional).
function nextParams(params: NodeParams, name: string, value: JsonValue | undefined): NodeParams {
  const next: NodeParams = { ...params }
  if (value === undefined) {
    delete next[name]
  } else {
    next[name] = value
  }
  return next
}

// --- Per-property controls -----------------------------------------------------------------------

interface ControlProps {
  name: string
  label: string
  prop: Record<string, JsonValue>
  current: JsonValue | undefined
  emit: (value: JsonValue | undefined) => void
  /** Id of the control's help text (`doc.help`), wired to the primary input via aria-describedby. */
  describedBy?: string
}

function NumberControl({ label, prop, current, emit, describedBy }: ControlProps): ReactElement {
  const isInteger = prop.type === 'integer'
  const minimum = asNumber(prop.minimum)
  const exclusiveMinimum = asNumber(prop.exclusiveMinimum)
  const maximum = asNumber(prop.maximum)
  // `exclusiveMinimum` has no native input attribute; surface it as the `min` hint plus a note.
  const minAttr = minimum ?? exclusiveMinimum
  return (
    <div className="pform__field">
      {/* The hint sits OUTSIDE the label so the control's accessible name is exactly `label`. */}
      <label className="pform__label-wrap">
        <span className="pform__label">{label}</span>
        <input
          type="number"
          className="pform__input"
          value={typeof current === 'number' ? current : ''}
          step={isInteger ? 1 : 'any'}
          min={minAttr}
          max={maximum}
          aria-describedby={describedBy}
          onChange={(e) => emit(parseFiniteNumber(e.target.value))}
        />
      </label>
      {exclusiveMinimum !== undefined ? (
        <span className="pform__hint">must be greater than {exclusiveMinimum}</span>
      ) : null}
    </div>
  )
}

function BooleanControl({ label, prop, current, emit, describedBy }: ControlProps): ReactElement {
  const fallback = typeof prop.default === 'boolean' ? prop.default : false
  const checked = typeof current === 'boolean' ? current : fallback
  return (
    <label className="pform__field pform__field--check">
      <input
        type="checkbox"
        className="pform__checkbox"
        checked={checked}
        aria-describedby={describedBy}
        onChange={(e) => emit(e.target.checked)}
      />
      <span className="pform__label">{label}</span>
    </label>
  )
}

function StringControl({ label, prop, current, emit, describedBy }: ControlProps): ReactElement {
  const minLength = asNumber(prop.minLength)
  return (
    <label className="pform__field">
      <span className="pform__label">{label}</span>
      <input
        type="text"
        className="pform__input"
        value={typeof current === 'string' ? current : ''}
        minLength={minLength}
        aria-describedby={describedBy}
        onChange={(e) => emit(e.target.value === '' ? undefined : e.target.value)}
      />
    </label>
  )
}

// A unique-string array editor (tickers): chips with remove buttons + an add field that rejects
// duplicates to honour `uniqueItems`. The value is always a string[].
function StringArrayControl({ label, current, emit, describedBy }: ControlProps): ReactElement {
  const items: string[] = Array.isArray(current)
    ? current.filter((v): v is string => typeof v === 'string')
    : []
  const [draft, setDraft] = useState('')
  const [dupError, setDupError] = useState<string | undefined>(undefined)

  const add = (): void => {
    const value = draft.trim()
    if (value === '') {
      return
    }
    if (items.includes(value)) {
      setDupError(`"${value}" is already in the list`)
      return
    }
    setDupError(undefined)
    setDraft('')
    emit([...items, value])
  }

  return (
    <div className="pform__field">
      <span className="pform__label">{label}</span>
      <ul className="pform__chips">
        {items.map((item) => (
          <li key={item} className="pform__chip">
            {item}
            <button
              type="button"
              className="pform__chip-remove"
              aria-label={`Remove ${item}`}
              onClick={() => emit(items.filter((v) => v !== item))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="pform__chip-add">
        <input
          type="text"
          className="pform__input"
          aria-label={`Add ${label}`}
          aria-describedby={describedBy}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setDupError(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="pform__btn" onClick={add}>
          Add
        </button>
      </div>
      {dupError !== undefined ? <span className="pform__hint pform__hint--error">{dupError}</span> : null}
    </div>
  )
}

// A two-branch `oneOf` control: a mode select between each `const` literal option and a bounded
// number branch (fixed_weight: "equal" vs a number). Emits the const value or the number. Mode is
// LOCAL state (seeded from the current value) so switching to the number branch before typing does
// not snap back to a const — the enclosing ParamForm remounts per node, resetting it cleanly.
function OneOfControl({ label, prop, current, emit, describedBy }: ControlProps): ReactElement {
  const branches = Array.isArray(prop.oneOf)
    ? prop.oneOf.map((b) => asRecord(b)).filter((b): b is Record<string, JsonValue> => b !== undefined)
    : []
  const constBranches = branches.filter((b) => 'const' in b)
  const hasNumberBranch = branches.some((b) => b.type === 'number' || b.type === 'integer')

  const currentConstIndex = constBranches.findIndex((b) => b.const === current)
  // When there is NO current value (a required oneOf with no schema `default`, e.g.
  // portfolio.fixed_weight.weight_per_asset), start UNSELECTED — mode `''` renders a disabled
  // placeholder so NOTHING appears chosen. Emitting a branch only happens when the user picks one:
  // showing a const branch as selected without emitting it makes the document lack a value the UI
  // implies it has, so a save then fails required-param validation confusingly. We never emit on mount.
  const initialMode =
    currentConstIndex >= 0
      ? `const:${currentConstIndex}`
      : typeof current === 'number' && hasNumberBranch
        ? 'number'
        : current === undefined
          ? ''
          : constBranches.length > 0
            ? 'const:0'
            : 'number'
  const [mode, setMode] = useState(initialMode)

  const options: { value: string; label: string }[] = constBranches.map((b, i) => ({
    value: `const:${i}`,
    label: String(b.const),
  }))
  if (hasNumberBranch) {
    options.push({ value: 'number', label: 'number' })
  }

  const onModeChange = (value: string): void => {
    setMode(value)
    if (value === '') {
      // The disabled placeholder is not selectable via the UI; guard anyway and emit nothing.
      return
    }
    if (value.startsWith('const:')) {
      const idx = Number(value.slice('const:'.length))
      emit(constBranches[idx]?.const)
    } else {
      // Switching to the number branch: keep an existing number, else clear until the user types.
      emit(typeof current === 'number' ? current : undefined)
    }
  }

  return (
    <div className="pform__field">
      <span className="pform__label">{label}</span>
      <select
        className="pform__input"
        aria-label={label}
        aria-describedby={describedBy}
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
      >
        {mode === '' ? (
          <option value="" disabled>
            — select —
          </option>
        ) : null}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {mode === 'number' ? (
        <input
          type="number"
          className="pform__input"
          aria-label={`${label} value`}
          value={typeof current === 'number' ? current : ''}
          onChange={(e) => emit(parseFiniteNumber(e.target.value))}
        />
      ) : null}
    </div>
  )
}

// The D6 fallback: a raw-JSON textarea bound to one property. On change, if the text parses we emit
// the parsed value; if it does not, we KEEP the text and show an "invalid JSON" hint (never block —
// the server validates authoritatively). Empty text clears the key.
function RawJsonControl({ label, current, emit, describedBy }: ControlProps): ReactElement {
  const [text, setText] = useState(() => (current === undefined ? '' : JSON.stringify(current, null, 2)))
  const [invalid, setInvalid] = useState(false)
  return (
    <div className="pform__field">
      <span className="pform__label">{label}</span>
      <textarea
        className="pform__textarea"
        aria-label={label}
        aria-describedby={describedBy}
        value={text}
        rows={3}
        onChange={(e) => {
          const value = e.target.value
          setText(value)
          if (value.trim() === '') {
            setInvalid(false)
            emit(undefined)
            return
          }
          try {
            const parsed = JSON.parse(value) as JsonValue
            setInvalid(false)
            emit(parsed)
          } catch {
            setInvalid(true)
          }
        }}
      />
      {invalid ? <span className="pform__hint pform__hint--error">invalid JSON</span> : null}
    </div>
  )
}

// Pick the control for one property from its (sub)schema. Order matters: `oneOf` first (it carries
// no top-level `type`), then the concrete scalar/array types, then the raw-JSON fallback.
function renderControl(props: ControlProps): ReactElement {
  const { prop } = props
  if ('oneOf' in prop) {
    return <OneOfControl {...props} />
  }
  if (prop.type === 'boolean') {
    return <BooleanControl {...props} />
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    return <NumberControl {...props} />
  }
  if (prop.type === 'string') {
    return <StringControl {...props} />
  }
  if (prop.type === 'array' && asRecord(prop.items)?.type === 'string') {
    return <StringArrayControl {...props} />
  }
  return <RawJsonControl {...props} />
}

export function ParamForm({ schema, params, docs, onParamsChange }: ParamFormProps): ReactElement {
  const properties = asRecord(schema?.properties ?? undefined)
  const required = Array.isArray(schema?.required)
    ? (schema.required as JsonValue[]).filter((r): r is string => typeof r === 'string')
    : []

  if (properties === undefined || Object.keys(properties).length === 0) {
    return <p className="pform__empty">This node has no parameters.</p>
  }

  return (
    <div className="pform">
      {Object.entries(properties).map(([name, propVal]) => {
        const prop = asRecord(propVal) ?? {}
        const docEntry = docs?.[name]
        // The visible/accessible label is the doc label; the emit key stays the raw property `name`.
        const label = docEntry?.label ?? name
        const help = docEntry?.help != null && docEntry.help !== '' ? docEntry.help : undefined
        // Help text sits UNDER the control (a column) and is announced via aria-describedby — never a
        // horizontal sibling of the input (that squeezed the layout and left the help unassociated).
        const helpId = help !== undefined ? `pform-help-${name}` : undefined
        const emit = (value: JsonValue | undefined): void =>
          onParamsChange(nextParams(params, name, value))
        return (
          <div key={name} className="pform__row">
            <div className="pform__control">
              {renderControl({
                name,
                label,
                prop,
                current: params[name],
                emit,
                // exactOptionalPropertyTypes: only pass describedBy when there is a help id to point at.
                ...(helpId !== undefined ? { describedBy: helpId } : {}),
              })}
              {help !== undefined ? (
                <span id={helpId} className="pform__help">
                  {help}
                </span>
              ) : null}
            </div>
            {required.includes(name) ? (
              <span className="pform__required" title="required">
                required
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
