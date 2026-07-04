// Strategy list / load / new / save (M11.5, D7).
//
// The document store is the single source of truth: "Load" REPLACES the store doc with the persisted
// IR verbatim; "Save" serializes the store doc verbatim. Save semantics (M9): a byte-identical POST
// is idempotent (200/201); a DIFFERENT document at an existing `(strategy_id, version)` is a 409
// (`ApiClientError.code === "artifact_conflict"`). So persisting edits requires the version to
// increment — the 409 recovery bumps `strategy.version` (pure `bumpStrategyVersion`) and retries once.
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { StrategyListRow } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError, listStrategies, listStrategyVersions, loadStrategyVersion, saveStrategy } from '../api/client'
import { bumpStrategyVersion, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'

export interface StrategyPanelProps {
  doc: StrategyDocument
  actions: StrategyDocumentActions
}

export function StrategyPanel({ doc, actions }: StrategyPanelProps): ReactElement {
  const [rows, setRows] = useState<StrategyListRow[]>([])
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('Untitled')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listStrategies()
      setRows(list.strategies)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Save the CURRENT store document. Byte-identical → 200/201; a different doc at an existing
  // (id, version) → 409 → offer the version bump.
  const onSave = async (): Promise<void> => {
    setError(undefined)
    setStatus(undefined)
    setSaving(true)
    try {
      const saved = await saveStrategy(doc)
      setStatus(`Saved version ${saved.version}.`)
      await refresh()
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'artifact_conflict') {
        setConflict(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  // Confirmed 409 recovery: bump the version, make the bumped doc canonical, retry the save ONCE.
  // We save the local `bumped` value (not `doc`) because `actions.replace` updates state async — the
  // prop `doc` is still the old version within this handler.
  const onConfirmBump = async (): Promise<void> => {
    const bumped = bumpStrategyVersion(doc)
    actions.replace(bumped)
    setConflict(false)
    setError(undefined)
    setSaving(true)
    try {
      const saved = await saveStrategy(bumped)
      setStatus(`Saved version ${saved.version}.`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Load the LATEST version of a strategy and replace the store doc with the persisted IR verbatim.
  const onLoad = async (strategyId: string): Promise<void> => {
    setError(undefined)
    setStatus(undefined)
    try {
      const { versions } = await listStrategyVersions(strategyId)
      if (versions.length === 0) {
        setError('This strategy has no stored versions.')
        return
      }
      const latest = versions.reduce((a, b) => (b > a ? b : a), versions[0])
      const loaded = await loadStrategyVersion(strategyId, latest)
      actions.replace(loaded)
      setStatus(`Loaded ${strategyId} v${latest}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onNew = (): void => {
    actions.replace(newStrategyDocument(newName.trim() === '' ? 'Untitled' : newName.trim()))
    setStatus('New strategy created.')
  }

  return (
    <div className="spanel">
      <div className="spanel__actions">
        <input
          type="text"
          className="pform__input"
          aria-label="new strategy name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="button" className="pform__btn" onClick={onNew}>
          New strategy
        </button>
        <button
          type="button"
          className="pform__btn pform__btn--primary"
          onClick={() => void onSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {status !== undefined ? <div className="spanel__status">{status}</div> : null}
      {error !== undefined ? (
        <div className="spanel__error" role="alert">
          {error}
        </div>
      ) : null}

      {conflict ? (
        <div className="spanel__dialog" role="dialog" aria-label="version conflict">
          <p>
            A different strategy already exists at version {doc.strategy.version}. Save as version{' '}
            {doc.strategy.version + 1}?
          </p>
          <button type="button" className="pform__btn pform__btn--primary" onClick={() => void onConfirmBump()}>
            Save as version {doc.strategy.version + 1}
          </button>
          <button type="button" className="pform__btn" onClick={() => setConflict(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      <ul className="spanel__list">
        {rows.map((row) => (
          <li key={`${row.strategy_id}:${row.version}`} className="spanel__row">
            <span className="spanel__row-name">{row.name}</span>
            <span className="spanel__row-meta">
              v{row.version} · {row.strategy_id}
            </span>
            <button type="button" className="pform__btn" onClick={() => void onLoad(row.strategy_id)}>
              Load
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
