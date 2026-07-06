import { describe, expect, it } from 'vitest'
import type { CatalogInputPortDto, CatalogOutputPortDto, NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
// Cross-root JSON imports are supported here (precedent: catalog/index.test.ts imports the node_catalog
// golden). The three fixtures below are the E7 extraction ORACLE.
import componentMomentumJson from '../../../tests/fixtures/component_momentum.json'
import nodeCatalogJson from '../../../tests/goldens/node_catalog.json'
import strategyAJson from '../../../tests/fixtures/strategy_a.json'
import strategyAComponentJson from '../../../tests/fixtures/strategy_a_component.json'
import { extractComponent } from './extract'
import type { ExtractSuccess } from './extract'

const CATALOG = nodeCatalogJson as unknown as NodeCatalogResponse

// Narrow an ExtractResult to success (fails the test with the error string if it did not extract).
function expectSuccess(result: ReturnType<typeof extractComponent>): ExtractSuccess {
  if ('error' in result) {
    throw new Error(`expected success, got error: ${result.error}`)
  }
  return result
}

function deep(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

// --- E7 ORACLE -----------------------------------------------------------------------------------
// Normalization (applied to BOTH produced and fixture before deep-equal), per plan E7:
//   definition: component_id, provenance.{created_at,owner,creator} → constants.
//   strategy:   strategy.{id,name,description} → constants; the minted ref id + minted node id +
//               component_id → constants (string-substituted across the doc); the ref node's params
//               → {} on BOTH sides (the fixture's {"n":3} is a hand-authored override demo).
// The definition NAME/DESCRIPTION are NOT normalized, so the oracle call passes the fixture's exact
// name/description; node-array order is NOT normalized (E3 inserts at the first-removed index).

function normalizeDefinition(def: unknown): unknown {
  const d = deep(def) as ComponentDefinition
  d.component_id = 'CID'
  d.provenance.created_at = 'TS'
  d.provenance.owner = 'OWNER'
  d.provenance.creator = 'CREATOR'
  return d
}

function normalizeStrategy(strat: unknown): unknown {
  const s = deep(strat) as StrategyDocument
  s.strategy.id = 'SID'
  s.strategy.name = 'SNAME'
  s.strategy.description = 'SDESC'
  const compNode = s.nodes.find((n) => n.type_id === 'component')
  if (compNode === undefined || !('ref' in compNode)) {
    throw new Error('expected a component node in the rewritten strategy')
  }
  compNode.params = {}
  const nodeId = compNode.id
  const refId = compNode.ref
  const componentId = s.component_refs.find((r) => r.id === refId)?.component_id
  if (componentId === undefined) {
    throw new Error(`no component_ref for ref "${refId}" in the rewritten strategy`)
  }
  let text = JSON.stringify(s)
  text = text.split(nodeId).join('NODE').split(refId).join('REF').split(componentId).join('CID')
  return JSON.parse(text)
}

describe('extractComponent — E7 oracle (momentum subgraph of Strategy A)', () => {
  const result = extractComponent(
    strategyAJson as unknown as StrategyDocument,
    new Set(['ret', 'rk', 'sel']),
    CATALOG,
    new Map<string, ComponentDefinition>(),
    {
      // Match the fixture's name/description exactly — E7 does NOT normalize definition name/description.
      name: 'Momentum Selector',
      description: 'Trailing-return momentum: rank descending, select the top n of the universe.',
      exposedParams: [
        { nodeId: 'ret', paramKey: 'lookback_sessions', exposedName: 'lookback_sessions' },
        { nodeId: 'sel', paramKey: 'n', exposedName: 'n' },
      ],
    },
  )
  const success = expectSuccess(result)

  it('produces the definition equal to component_momentum.json (modulo minted id + provenance)', () => {
    expect(normalizeDefinition(success.definition)).toEqual(
      normalizeDefinition(componentMomentumJson),
    )
  })

  it('produces the strategy equal to strategy_a_component.json (modulo minted ids + meta + params)', () => {
    expect(normalizeStrategy(success.strategy)).toEqual(
      normalizeStrategy(strategyAComponentJson),
    )
  })

  it('exposes inputs [series, universe] in document edge order with copied types', () => {
    expect(success.definition.exposed_inputs).toEqual([
      { name: 'series', type: { kind: 'TimeSeries', dtype: 'Number' }, maps_to: ['ret', 'series'] },
      { name: 'universe', type: { kind: 'AssetSet' }, maps_to: ['sel', 'universe'] },
    ])
  })

  it('exposes output [assets] mapped to the inner (sel, assets) source', () => {
    expect(success.definition.exposed_outputs).toEqual([
      { name: 'assets', type: { kind: 'AssetSet' }, maps_to: ['sel', 'assets'] },
    ])
  })

  it('exposes params in opts order with schema fragments copied verbatim from the catalog', () => {
    expect(success.definition.exposed_params).toEqual([
      { name: 'lookback_sessions', binds_to: ['ret', 'lookback_sessions'], schema: { type: 'integer', minimum: 1 } },
      { name: 'n', binds_to: ['sel', 'n'], schema: { type: 'integer', minimum: 1 } },
    ])
  })

  it('places the minted instance node at index 2 (the first removed node index) with no ui', () => {
    const node = success.strategy.nodes[2]
    expect(node.type_id).toBe('component')
    expect(node.ui).toBeUndefined()
    expect(node.params).toEqual({})
  })

  it('mints hyphen-free ids and a uuid component_id', () => {
    expect(success.definition.component_id).toMatch(/^[0-9a-fA-F-]{36}$/)
    const node = success.strategy.nodes[2]
    expect(node.id).toMatch(/^[A-Za-z0-9_]+$/)
    expect(node.id).not.toContain('-')
    expect(success.strategy.component_refs[0].id).not.toContain('-')
  })

  it('leaves the input document unmutated', () => {
    const before = deep(strategyAJson)
    extractComponent(
      strategyAJson as unknown as StrategyDocument,
      new Set(['ret', 'rk', 'sel']),
      CATALOG,
      new Map(),
      { name: 'X', exposedParams: [] },
    )
    expect(deep(strategyAJson)).toEqual(before)
  })
})

// --- Synthetic-catalog helpers for adversarial unit tests ----------------------------------------

const CS = { kind: 'CrossSection', dtype: 'Number' } as const
const AS = { kind: 'AssetSet' } as const

function inPort(name: string, portType: CatalogInputPortDto['port_type']): CatalogInputPortDto {
  return { name, port_type: portType, required: true }
}
function outPort(name: string, portType: CatalogOutputPortDto['port_type']): CatalogOutputPortDto {
  return { name, port_type: portType }
}
function nodeType(
  typeId: string,
  inputs: CatalogInputPortDto[],
  outputs: CatalogOutputPortDto[],
): NodeTypeDto {
  return {
    type_id: typeId,
    type_version: '1.0.0',
    display_name: typeId,
    description: '',
    inputs,
    outputs,
    parameter_schema: null,
  }
}
function makeCatalog(nodeTypes: NodeTypeDto[]): NodeCatalogResponse {
  return {
    api_version: 'v1',
    schema_version: '0.1.0',
    catalog_digest: '0'.repeat(64),
    port_types: [],
    compatibility: [],
    node_types: nodeTypes,
  }
}
function makeDoc(
  nodes: StrategyDocument['nodes'],
  edges: StrategyDocument['edges'],
  componentRefs: StrategyDocument['component_refs'] = [],
): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 1,
      name: 'adv',
      provenance: {
        owner: '00000000-0000-0000-0000-000000000001',
        creator: '00000000-0000-0000-0000-000000000001',
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: '2026-07-06T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    nodes,
    edges,
    component_refs: componentRefs,
  }
}
function reg(id: string, typeId: string): StrategyDocument['nodes'][number] {
  return { id, type_id: typeId, type_version: '1.0.0', params: {} }
}

describe('extractComponent — edge classification', () => {
  it('fan-out output: one inner source, two outer consumers → 1 exposed output, 2 rewired edges', () => {
    const catalog = makeCatalog([
      nodeType('src', [], [outPort('out', AS)]),
      nodeType('sink', [inPort('in', AS)], []),
    ])
    const doc = makeDoc(
      [reg('s', 'src'), reg('o1', 'sink'), reg('o2', 'sink')],
      [
        { from: ['s', 'out'], to: ['o1', 'in'] },
        { from: ['s', 'out'], to: ['o2', 'in'] },
      ],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['s']), catalog, new Map(), { name: 'C', exposedParams: [] }),
    )
    expect(definition.exposed_outputs).toEqual([
      { name: 'out', type: AS, maps_to: ['s', 'out'] },
    ])
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(strategy.edges).toEqual([
      { from: [node.id, 'out'], to: ['o1', 'in'] },
      { from: [node.id, 'out'], to: ['o2', 'in'] },
    ])
  })

  it('a node feeding inside AND outside: inner edge stays internal, outer edge → exposed output', () => {
    const catalog = makeCatalog([nodeType('m', [inPort('in', CS)], [outPort('out', CS)])])
    const doc = makeDoc(
      [reg('x', 'm'), reg('y', 'm'), reg('z', 'm')],
      [
        { from: ['x', 'out'], to: ['y', 'in'] }, // inside→inside
        { from: ['x', 'out'], to: ['z', 'in'] }, // inside→outside
      ],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), { name: 'C', exposedParams: [] }),
    )
    expect(definition.implementation.graph.edges).toEqual([
      { from: ['x', 'out'], to: ['y', 'in'] },
    ])
    expect(definition.exposed_outputs).toEqual([{ name: 'out', type: CS, maps_to: ['x', 'out'] }])
    expect(definition.exposed_inputs).toEqual([])
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(strategy.edges).toEqual([{ from: [node.id, 'out'], to: ['z', 'in'] }])
  })

  it('exposed-port name collision suffixes deterministically (values, values_2)', () => {
    const catalog = makeCatalog([
      nodeType('dual', [inPort('values', CS), inPort('link', CS)], [outPort('out', CS)]),
    ])
    const doc = makeDoc(
      [reg('x', 'dual'), reg('y', 'dual'), reg('o1', 'dual'), reg('o2', 'dual')],
      [
        { from: ['x', 'out'], to: ['y', 'link'] }, // internal (connectivity)
        { from: ['o1', 'out'], to: ['x', 'values'] }, // boundary in → values
        { from: ['o2', 'out'], to: ['y', 'values'] }, // boundary in → values_2
      ],
    )
    const { definition } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), { name: 'C', exposedParams: [] }),
    )
    expect(definition.exposed_inputs.map((p) => p.name)).toEqual(['values', 'values_2'])
    expect(definition.exposed_inputs.map((p) => p.maps_to)).toEqual([
      ['x', 'values'],
      ['y', 'values'],
    ])
  })

  it('portNames overrides an exposed name (keyed by its default), leaving others suffixed', () => {
    const catalog = makeCatalog([
      nodeType('dual', [inPort('values', CS), inPort('link', CS)], [outPort('out', CS)]),
    ])
    const doc = makeDoc(
      [reg('x', 'dual'), reg('y', 'dual'), reg('o1', 'dual'), reg('o2', 'dual')],
      [
        { from: ['x', 'out'], to: ['y', 'link'] },
        { from: ['o1', 'out'], to: ['x', 'values'] },
        { from: ['o2', 'out'], to: ['y', 'values'] },
      ],
    )
    const { definition } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), {
        name: 'C',
        exposedParams: [],
        portNames: new Map([['values', 'series']]),
      }),
    )
    expect(definition.exposed_inputs.map((p) => p.name)).toEqual(['series', 'values_2'])
  })

  it('rejects a portNames override that is not a valid identifier', () => {
    const catalog = makeCatalog([nodeType('sink', [inPort('in', AS)], []), nodeType('src', [], [outPort('out', AS)])])
    const doc = makeDoc(
      [reg('a', 'src'), reg('b', 'sink')],
      [{ from: ['a', 'out'], to: ['b', 'in'] }],
    )
    const result = extractComponent(doc, new Set(['b']), catalog, new Map(), {
      name: 'C',
      exposedParams: [],
      portNames: new Map([['in', 'bad name!']]),
    })
    expect('error' in result).toBe(true)
  })

  it('honors overrides keyed by the PREVIEW defaults even when they shift collision suffixes (A4)', () => {
    // Two boundary inputs both default to "a" → preview shows "a", "a_2". The user renames the FIRST
    // to "a_2" and the SECOND to "q". Overrides are keyed by the preview defaults ("a", "a_2"), so a
    // two-pass assignment must honor BOTH — never recompute "a_2" for the first override and silently
    // drop the "q" rename (the streaming bug this fix closes).
    const catalog = makeCatalog([
      nodeType('box', [inPort('a', CS), inPort('link', CS)], [outPort('out', CS)]),
      nodeType('src', [], [outPort('out', CS)]),
    ])
    const doc = makeDoc(
      [reg('x', 'box'), reg('y', 'box'), reg('o1', 'src'), reg('o2', 'src')],
      [
        { from: ['x', 'out'], to: ['y', 'link'] }, // internal (connectivity)
        { from: ['o1', 'out'], to: ['x', 'a'] }, // boundary in → default "a"
        { from: ['o2', 'out'], to: ['y', 'a'] }, // boundary in → default "a_2"
      ],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), {
        name: 'C',
        exposedParams: [],
        portNames: new Map([
          ['a', 'a_2'],
          ['a_2', 'q'],
        ]),
      }),
    )
    // Both renames are honored: the finals are exactly the user's choices, in preview (document) order.
    expect(definition.exposed_inputs.map((p) => p.name)).toEqual(['a_2', 'q'])
    expect(definition.exposed_inputs.map((p) => p.maps_to)).toEqual([
      ['x', 'a'],
      ['y', 'a'],
    ])
    // The rewired strategy edges reference the FINAL instance port names (not the shifted defaults).
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(strategy.edges).toEqual([
      { from: ['o1', 'out'], to: [node.id, 'a_2'] },
      { from: ['o2', 'out'], to: [node.id, 'q'] },
    ])
  })

  it('rejects overrides that collide in the FINAL set after a suffix shift (A4)', () => {
    // Two boundary inputs default "a", "a_2". Renaming ONLY the second back to "a" collapses both finals
    // onto "a" — a final-set duplicate that must be rejected (keyed by preview defaults, validated final).
    const catalog = makeCatalog([
      nodeType('box', [inPort('a', CS), inPort('link', CS)], [outPort('out', CS)]),
      nodeType('src', [], [outPort('out', CS)]),
    ])
    const doc = makeDoc(
      [reg('x', 'box'), reg('y', 'box'), reg('o1', 'src'), reg('o2', 'src')],
      [
        { from: ['x', 'out'], to: ['y', 'link'] },
        { from: ['o1', 'out'], to: ['x', 'a'] },
        { from: ['o2', 'out'], to: ['y', 'a'] },
      ],
    )
    const result = extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), {
      name: 'C',
      exposedParams: [],
      portNames: new Map([['a_2', 'a']]),
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('used more than once')
    }
  })

  it('rejects two portNames overrides that collapse two exposed ports onto one name', () => {
    const catalog = makeCatalog([
      nodeType('dual', [inPort('values', CS), inPort('link', CS)], [outPort('out', CS)]),
      nodeType('src', [], [outPort('out', CS)]),
    ])
    // Two distinct boundary inputs (x.values, x.link) each overridden to the SAME exposed name → the
    // second override collides with the first's reservation and must be rejected (ambiguous wiring).
    const doc = makeDoc(
      [reg('x', 'dual'), reg('o1', 'src'), reg('o2', 'src')],
      [
        { from: ['o1', 'out'], to: ['x', 'values'] },
        { from: ['o2', 'out'], to: ['x', 'link'] },
      ],
    )
    const result = extractComponent(doc, new Set(['x']), catalog, new Map(), {
      name: 'C',
      exposedParams: [],
      portNames: new Map([
        ['values', 'same'],
        ['link', 'same'],
      ]),
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('used more than once')
    }
  })
})

describe('extractComponent — nested component instances (E4)', () => {
  const nestedDef: ComponentDefinition = {
    schema_version: '0.1.0',
    component_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    version: '2.0.0',
    name: 'Nested',
    description: null,
    component_refs: [],
    implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
    exposed_inputs: [{ name: 'feed', type: CS, maps_to: ['inner', 'in'] }],
    exposed_outputs: [{ name: 'result', type: AS, maps_to: ['inner', 'out'] }],
    exposed_params: [],
    provenance: {
      owner: '00000000-0000-0000-0000-000000000001',
      creator: '00000000-0000-0000-0000-000000000001',
      contributors: [],
      visibility: 'private',
      duplicable: false,
      created_at: '2026-07-06T00:00:00Z',
      forked_from: null,
    },
  }
  const cache = new Map<string, ComponentDefinition>([
    ['cccccccc-cccc-cccc-cccc-cccccccccccc@2.0.0', nestedDef],
  ])

  it('copies a selected instance ref into the definition and drops it from the strategy when unused outside', () => {
    const catalog = makeCatalog([])
    const doc = makeDoc(
      [{ id: 'c1', type_id: 'component', ref: 'r0', params: {} }],
      [],
      [{ id: 'r0', component_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version: '2.0.0' }],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['c1']), catalog, cache, { name: 'Wrap', exposedParams: [] }),
    )
    expect(definition.component_refs).toEqual([
      { id: 'r0', component_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version: '2.0.0' },
    ])
    // r0 no longer used outside → dropped; only the newly minted ref remains.
    expect(strategy.component_refs.some((r) => r.id === 'r0')).toBe(false)
    expect(strategy.component_refs).toHaveLength(1)
  })

  it('keeps a moved ref in the strategy when another OUTSIDE instance still uses it', () => {
    const catalog = makeCatalog([])
    const doc = makeDoc(
      [
        { id: 'c1', type_id: 'component', ref: 'r0', params: {} },
        { id: 'c2', type_id: 'component', ref: 'r0', params: {} },
      ],
      [],
      [{ id: 'r0', component_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version: '2.0.0' }],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['c1']), catalog, cache, { name: 'Wrap', exposedParams: [] }),
    )
    expect(definition.component_refs.map((r) => r.id)).toEqual(['r0'])
    expect(strategy.component_refs.some((r) => r.id === 'r0')).toBe(true)
  })

  it('reads a nested instance boundary port type from its cached definition', () => {
    const catalog = makeCatalog([nodeType('sink', [inPort('in', AS)], [])])
    const doc = makeDoc(
      [
        { id: 'c1', type_id: 'component', ref: 'r0', params: {} },
        reg('o', 'sink'),
      ],
      [{ from: ['c1', 'result'], to: ['o', 'in'] }],
      [{ id: 'r0', component_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version: '2.0.0' }],
    )
    const { definition } = expectSuccess(
      extractComponent(doc, new Set(['c1']), catalog, cache, { name: 'Wrap', exposedParams: [] }),
    )
    // 'result' output of the nested instance is AssetSet per its cached definition.
    expect(definition.exposed_outputs).toEqual([{ name: 'result', type: AS, maps_to: ['c1', 'result'] }])
  })
})

describe('extractComponent — pre-checks and verbatim preservation', () => {
  it('errors on an empty selection', () => {
    const doc = makeDoc([reg('a', 'src')], [])
    const result = extractComponent(doc, new Set(), makeCatalog([]), new Map(), {
      name: 'C',
      exposedParams: [],
    })
    expect('error' in result).toBe(true)
  })

  it('errors on a disconnected selection', () => {
    const catalog = makeCatalog([nodeType('n', [], [])])
    const doc = makeDoc([reg('a', 'n'), reg('b', 'n')], [])
    const result = extractComponent(doc, new Set(['a', 'b']), catalog, new Map(), {
      name: 'C',
      exposedParams: [],
    })
    expect('error' in result).toBe(true)
  })

  it('preserves genuinely-unknown future keys on the rewritten strategy and does not mutate the input', () => {
    const catalog = makeCatalog([nodeType('m', [inPort('in', CS)], [outPort('out', CS)])])
    const base = {
      ...makeDoc(
        [reg('x', 'm'), reg('y', 'm'), reg('z', 'm')],
        [
          { from: ['x', 'out'], to: ['y', 'in'] },
          { from: ['y', 'out'], to: ['z', 'in'] },
        ],
      ),
      __future_field__: { keep: 'me' },
    } as unknown as StrategyDocument
    const before = deep(base)
    const { strategy } = expectSuccess(
      extractComponent(base, new Set(['x', 'y']), catalog, new Map(), { name: 'C', exposedParams: [] }),
    )
    expect((strategy as unknown as Record<string, unknown>).__future_field__).toEqual({ keep: 'me' })
    expect(deep(base)).toEqual(before)
  })
})

// A registered node carrying a `ui.position` (the `reg` helper deliberately omits ui).
function regAt(id: string, typeId: string, x: number, y: number): StrategyDocument['nodes'][number] {
  return { id, type_id: typeId, type_version: '1.0.0', params: {}, ui: { position: { x, y } } }
}

describe('extractComponent — minted node ui centroid', () => {
  it('places the minted node at the bounding-box centroid of the selected positions', () => {
    const catalog = makeCatalog([nodeType('m', [inPort('in', CS)], [outPort('out', CS)])])
    // positions (0,0),(100,0),(0,40) → centroid ((0+100)/2, (0+40)/2) = (50,20).
    const doc = makeDoc(
      [regAt('x', 'm', 0, 0), regAt('y', 'm', 100, 0), regAt('z', 'm', 0, 40)],
      [
        { from: ['x', 'out'], to: ['y', 'in'] },
        { from: ['y', 'out'], to: ['z', 'in'] },
      ],
    )
    const { strategy } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y', 'z']), catalog, new Map(), {
        name: 'C',
        exposedParams: [],
      }),
    )
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(node.ui).toEqual({ position: { x: 50, y: 20 } })
  })

  it('computes the centroid over ONLY the selected nodes that carry a position', () => {
    const catalog = makeCatalog([nodeType('m', [inPort('in', CS)], [outPort('out', CS)])])
    // x@(0,0) and y@(100,40) have positions; z has none → centroid over {x,y} = (50,20).
    const doc = makeDoc(
      [regAt('x', 'm', 0, 0), regAt('y', 'm', 100, 40), reg('z', 'm')],
      [
        { from: ['x', 'out'], to: ['y', 'in'] },
        { from: ['y', 'out'], to: ['z', 'in'] },
      ],
    )
    const { strategy } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y', 'z']), catalog, new Map(), {
        name: 'C',
        exposedParams: [],
      }),
    )
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(node.ui).toEqual({ position: { x: 50, y: 20 } })
  })

  it('omits ui entirely (not {}) when no selected node has a position', () => {
    const catalog = makeCatalog([nodeType('m', [inPort('in', CS)], [outPort('out', CS)])])
    const doc = makeDoc(
      [reg('x', 'm'), reg('y', 'm')],
      [{ from: ['x', 'out'], to: ['y', 'in'] }],
    )
    const { strategy } = expectSuccess(
      extractComponent(doc, new Set(['x', 'y']), catalog, new Map(), {
        name: 'C',
        exposedParams: [],
      }),
    )
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(node.ui).toBeUndefined()
    expect('ui' in node).toBe(false)
  })
})

describe('extractComponent — additional edge/param cases', () => {
  it('two outside sources into one inner input port → 1 exposed input, 2 rewired edges', () => {
    const catalog = makeCatalog([
      nodeType('sink', [inPort('in', CS)], []),
      nodeType('src', [], [outPort('out', CS)]),
    ])
    const doc = makeDoc(
      [reg('x', 'sink'), reg('o1', 'src'), reg('o2', 'src')],
      [
        { from: ['o1', 'out'], to: ['x', 'in'] },
        { from: ['o2', 'out'], to: ['x', 'in'] },
      ],
    )
    const { definition, strategy } = expectSuccess(
      extractComponent(doc, new Set(['x']), catalog, new Map(), { name: 'C', exposedParams: [] }),
    )
    expect(definition.exposed_inputs).toEqual([{ name: 'in', type: CS, maps_to: ['x', 'in'] }])
    const node = strategy.nodes.find((n) => n.type_id === 'component')!
    expect(strategy.edges).toEqual([
      { from: ['o1', 'out'], to: [node.id, 'in'] },
      { from: ['o2', 'out'], to: [node.id, 'in'] },
    ])
  })

  it('errors when an exposedParams entry references a non-selected node', () => {
    const catalog = makeCatalog([nodeType('m', [], [])])
    const doc = makeDoc([reg('x', 'm'), reg('y', 'm')], [])
    const result = extractComponent(doc, new Set(['x']), catalog, new Map(), {
      name: 'C',
      exposedParams: [{ nodeId: 'y', paramKey: 'p', exposedName: 'p' }],
    })
    expect('error' in result).toBe(true)
  })
})
