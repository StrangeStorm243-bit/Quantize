// Palette tests (M12.3): the "Components" section renders saved-component rows from `listComponents`
// and each row is a drag source carrying the component MIME. NO network — `getNodeCatalog` and
// `listComponents` are mocked; the catalog resolves to the committed golden.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogProvider } from '../catalog'
import { COMPONENT_DRAG_MIME, Palette } from './Palette'

vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    listComponents: () =>
      Promise.resolve({
        components: [
          {
            component_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: 'Momentum',
            version: '1.0.0',
            schema_version: '0.1.0',
            saved_at: '2026-07-06T00:00:00Z',
          },
        ],
      }),
    errorMessage: (e: unknown) => String(e),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Palette components section', () => {
  it('renders a draggable row per saved component (name + version)', async () => {
    render(
      <CatalogProvider>
        <Palette />
      </CatalogProvider>,
    )
    expect(await screen.findByText('Momentum · v1.0.0')).toBeInTheDocument()
  })

  it('sets the component MIME with {component_id, version} on drag start', async () => {
    render(
      <CatalogProvider>
        <Palette />
      </CatalogProvider>,
    )
    const row = await screen.findByText('Momentum · v1.0.0')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } })
    expect(setData).toHaveBeenCalledWith(
      COMPONENT_DRAG_MIME,
      JSON.stringify({ component_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: '1.0.0' }),
    )
  })
})
