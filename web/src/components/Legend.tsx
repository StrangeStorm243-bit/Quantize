// The on-canvas port-type legend (M13.4). It reads the catalog's `port_types[]` and its human labels
// verbatim — so a future lattice member (`Matrix`, `Distribution`) appears here with ZERO code change,
// colored by the same token map the handles/edges use. Pure presentation of served data (invariant 5).
import type { ReactElement } from 'react'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import { labelOf } from '../catalog'
import { portColor } from '../catalog/colors'

export function Legend({ catalog }: { catalog: NodeCatalogResponse }): ReactElement {
  return (
    <div className="legend" aria-label="port type legend">
      <span className="legend__title">Port types</span>
      {catalog.port_types.map((entry) => (
        <span className="legend__item" key={labelOf(catalog, entry.port_type)}>
          <span className="legend__swatch" style={{ background: portColor(entry.port_type) }} />
          {labelOf(catalog, entry.port_type)}
        </span>
      ))}
    </div>
  )
}
