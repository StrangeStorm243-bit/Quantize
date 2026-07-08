import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { labelOf } from '../catalog'
import { Legend } from './Legend'

const catalog = catalogJson as unknown as NodeCatalogResponse

describe('Legend', () => {
  it('lists exactly the catalog port types, each with its human label', () => {
    const { container } = render(<Legend catalog={catalog} />)
    // One swatch per catalog port type — no more, no less (data-driven, not hard-coded).
    expect(container.querySelectorAll('.legend__item')).toHaveLength(catalog.port_types.length)
    for (const entry of catalog.port_types) {
      expect(screen.getByText(labelOf(catalog, entry.port_type))).toBeInTheDocument()
    }
  })
})
