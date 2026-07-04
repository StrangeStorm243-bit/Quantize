// ParamForm renders the D6 schema subset. Real param schemas come from the committed golden so the
// test tracks the true catalog; the unknown-construct case uses a hand-built schema. NO network.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type { JsonValue } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { nodeTypeById } from '../catalog'
import type { NodeParams } from '../document/store'
import { ParamForm } from './ParamForm'
import type { ParameterSchema } from './ParamForm'

const catalog = catalogJson as unknown as NodeCatalogResponse

function schemaOf(typeId: string): ParameterSchema {
  const nt = nodeTypeById(catalog, typeId)
  if (nt === undefined) {
    throw new Error(`missing node type ${typeId}`)
  }
  return nt.parameter_schema
}

describe('ParamForm', () => {
  it('renders transform.rank as a checkbox seeded from params (descending: true)', () => {
    const onParamsChange = vi.fn()
    render(
      <ParamForm schema={schemaOf('transform.rank')} params={{ descending: true }} onParamsChange={onParamsChange} />,
    )
    const checkbox = screen.getByLabelText('descending') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(onParamsChange).toHaveBeenCalledWith({ descending: false })
  })

  it('renders transform.moving_average as an integer input and emits the number', () => {
    const onParamsChange = vi.fn()
    render(<ParamForm schema={schemaOf('transform.moving_average')} params={{}} onParamsChange={onParamsChange} />)
    const input = screen.getByLabelText('window') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input).toHaveAttribute('step', '1')
    fireEvent.change(input, { target: { value: '20' } })
    expect(onParamsChange).toHaveBeenCalledWith({ window: 20 })
  })

  it('renders risk.max_weight as a number input carrying the max hint', () => {
    render(<ParamForm schema={schemaOf('risk.max_weight')} params={{}} onParamsChange={vi.fn()} />)
    const input = screen.getByLabelText('max') as HTMLInputElement
    expect(input.type).toBe('number')
    expect(input).toHaveAttribute('max', '1')
  })

  it('renders universe.fixed_list tickers as a chip editor (add, reject duplicate, remove)', () => {
    const onParamsChange = vi.fn()
    render(
      <ParamForm schema={schemaOf('universe.fixed_list')} params={{ tickers: ['AAA'] }} onParamsChange={onParamsChange} />,
    )
    // Existing chip present.
    expect(screen.getByText('AAA')).toBeInTheDocument()

    // Add a new unique ticker.
    fireEvent.change(screen.getByLabelText('Add tickers'), { target: { value: 'BBB' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onParamsChange).toHaveBeenCalledWith({ tickers: ['AAA', 'BBB'] })

    onParamsChange.mockClear()
    // Adding a duplicate is rejected — no emit, a hint appears.
    fireEvent.change(screen.getByLabelText('Add tickers'), { target: { value: 'AAA' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onParamsChange).not.toHaveBeenCalled()
    expect(screen.getByText(/already in the list/)).toBeInTheDocument()

    // Remove the existing chip.
    fireEvent.click(screen.getByRole('button', { name: 'Remove AAA' }))
    expect(onParamsChange).toHaveBeenCalledWith({ tickers: [] })
  })

  it('renders portfolio.fixed_weight oneOf as a mode toggle emitting the right value', () => {
    const onParamsChange = vi.fn()
    render(
      <ParamForm
        schema={schemaOf('portfolio.fixed_weight')}
        params={{ weight_per_asset: 'equal' }}
        onParamsChange={onParamsChange}
      />,
    )
    const select = screen.getByLabelText('weight_per_asset') as HTMLSelectElement
    // Seeded on the "equal" const branch; the number sub-input is hidden.
    expect(select.value).toBe('const:0')
    expect(screen.queryByLabelText('weight_per_asset value')).not.toBeInTheDocument()

    // Switch to the number branch → a number input appears; typing emits the number.
    fireEvent.change(select, { target: { value: 'number' } })
    const numberInput = screen.getByLabelText('weight_per_asset value') as HTMLInputElement
    fireEvent.change(numberInput, { target: { value: '0.5' } })
    expect(onParamsChange).toHaveBeenCalledWith({ weight_per_asset: 0.5 })

    // Switch back to the const branch → emits the const literal.
    onParamsChange.mockClear()
    fireEvent.change(select, { target: { value: 'const:0' } })
    expect(onParamsChange).toHaveBeenCalledWith({ weight_per_asset: 'equal' })
  })

  it('falls back to a raw-JSON textarea for an unrenderable construct', () => {
    const onParamsChange = vi.fn()
    // An object-typed property matches none of the specific controls → raw-JSON fallback.
    const schema: ParameterSchema = {
      type: 'object',
      properties: { cfg: { type: 'object' } as unknown as JsonValue },
    }
    const params: NodeParams = {}
    render(<ParamForm schema={schema} params={params} onParamsChange={onParamsChange} />)
    const textarea = screen.getByLabelText('cfg') as HTMLTextAreaElement
    expect(textarea.tagName).toBe('TEXTAREA')

    // Valid JSON → emits the parsed value.
    fireEvent.change(textarea, { target: { value: '{"a":1}' } })
    expect(onParamsChange).toHaveBeenCalledWith({ cfg: { a: 1 } })

    // Invalid JSON → keeps the text, shows the hint, emits nothing further.
    onParamsChange.mockClear()
    fireEvent.change(textarea, { target: { value: '{"a":' } })
    expect(onParamsChange).not.toHaveBeenCalled()
    expect(screen.getByText('invalid JSON')).toBeInTheDocument()
    expect((screen.getByLabelText('cfg') as HTMLTextAreaElement).value).toBe('{"a":')
  })
})
