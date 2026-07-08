// The node validity badge (M13.4, D-7): a small corner mark presenting the LATEST validation only —
// never a stale green (the App clears validity on any semantic doc mutation). Pure presentation of a
// server diagnostic verdict; it judges nothing (invariant 5). Shared by every node-card variant.
import type { ReactElement } from 'react'
import type { NodeValidity } from '../document/flow'

export function ValidityBadge({ validity }: { validity: NodeValidity | undefined }): ReactElement | null {
  if (validity === undefined) {
    return null
  }
  const label = validity === 'error' ? 'has problems' : 'valid'
  return (
    <span
      className={`snode__badge snode__badge--${validity}`}
      title={label}
      aria-label={label}
    >
      {validity === 'error' ? '!' : '✓'}
    </span>
  )
}
