// M11.2 — API client tests. NO network: a hand-mocked global fetch (D11) records the method, URL,
// and body each wrapper builds, and returns a canned typed payload. Fixtures are small typed
// literals shaped by the generated interfaces, so a contract change breaks these at compile time.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BacktestRunRequest,
  MetaResponse,
  NodeCatalogResponse,
  NodeValueResponse,
  RunRecordResponse,
  TraceResponse,
  TraceTreeResponse,
  ValidateResponse,
} from '@quantize/quantize-api'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import {
  ApiClientError,
  getMeta,
  getNodeCatalog,
  getNodeValue,
  getRun,
  getTrace,
  getTraceTree,
  listDatasets,
  listRuns,
  loadStrategyVersion,
  runBacktest,
  saveComponent,
  saveStrategy,
  validateStrategy,
} from './client'

// A minimal, fully-typed StrategyDocument used as a POST body / load payload fixture.
const DOC: StrategyDocument = {
  schema_version: '0.1.0',
  strategy: {
    id: '00000000-0000-0000-0000-0000000000aa',
    name: 'Fixture',
    version: 1,
    provenance: {
      owner: '00000000-0000-0000-0000-000000000001',
      creator: '00000000-0000-0000-0000-000000000001',
      contributors: [],
      created_at: '2026-07-04T00:00:00Z',
      duplicable: true,
      visibility: 'private',
    },
  },
  execution_policy: {
    policy: 'close_signal_next_session_open',
    valuation: 'session_close',
    transaction_costs: { model: 'bps', bps: 0 },
  },
  schedule: { kind: 'daily' },
  component_refs: [],
  nodes: [],
  edges: [],
}

// A minimal, fully-typed NodeValueResponse used as a served value-tap payload fixture.
const NODE_VALUE: NodeValueResponse = {
  node_id: 'n1',
  output_port: 'out',
  component_path: [],
  session_date: '2026-05-15',
  value_summary: { kind: 'scalar', dtype: 'Number', value: 1.5 },
  provenance: {
    captured: true,
    dataset_fingerprint: '0'.repeat(64),
    run_id: 'r1',
  },
}

// Build a Response-like stub. `fetch` in the client only touches `ok`, `status`, `statusText`, and
// `json()`, so we implement exactly that surface.
function stubResponse(
  data: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): Response {
  const { ok = true, status = 200, statusText = 'OK' } = init
  return {
    ok,
    status,
    statusText,
    json: async () => data,
  } as unknown as Response
}

function mockFetch(response: Response): void {
  // stubGlobal is self-restoring via unstubAllGlobals in beforeEach; resolves on every call
  // (some tests invoke a wrapper more than once).
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

function lastCall(): [string, RequestInit | undefined] {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  const call = mock.mock.calls[0] as [string, RequestInit | undefined]
  return call
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('GET wrappers', () => {
  it('getMeta issues GET /v1/meta and returns the parsed body', async () => {
    const meta: MetaResponse = {
      api_version: 'v1',
      schema_version: '0.1.0',
      record_format: 1,
      trace_format: 1,
    }
    mockFetch(stubResponse(meta))

    const result = await getMeta()

    const [url, init] = lastCall()
    expect(url).toBe('/v1/meta')
    // A bare GET passes no init (or no method) — never a body.
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(meta)
  })

  it('getNodeCatalog issues GET /v1/node-types', async () => {
    const catalog: NodeCatalogResponse = {
      api_version: 'v1',
      schema_version: '0.1.0',
      catalog_digest: '0'.repeat(64),
      port_types: [],
      compatibility: [],
      node_types: [],
    }
    mockFetch(stubResponse(catalog))

    const result = await getNodeCatalog()

    expect(lastCall()[0]).toBe('/v1/node-types')
    expect(result).toEqual(catalog)
  })

  it('listDatasets issues GET /v1/datasets', async () => {
    mockFetch(stubResponse({ datasets: [] }))

    const result = await listDatasets()

    expect(lastCall()[0]).toBe('/v1/datasets')
    expect(result).toEqual({ datasets: [] })
  })

  it('loadStrategyVersion encodes path params and parses the raw IR document', async () => {
    mockFetch(stubResponse(DOC))

    const result = await loadStrategyVersion('id/with space', 3)

    const [url, init] = lastCall()
    expect(url).toBe('/v1/strategies/id%2Fwith%20space/versions/3')
    expect(init?.method).toBeUndefined()
    expect(result).toEqual(DOC)
  })

  it('getRun issues GET /v1/runs/{id}', async () => {
    const record = { record: {}, replay_verifiable: true } as unknown as RunRecordResponse
    mockFetch(stubResponse(record))

    await getRun('run 1')

    expect(lastCall()[0]).toBe('/v1/runs/run%201')
  })

  it('getTrace appends the encoded session_date query', async () => {
    const trace: TraceResponse = { events: [] }
    mockFetch(stubResponse(trace))

    const result = await getTrace('r1', '2025-08-01')

    expect(lastCall()[0]).toBe('/v1/runs/r1/trace?session_date=2025-08-01')
    expect(result).toEqual(trace)
  })

  it('getTraceTree GETs the tree URL with an encoded session filter', async () => {
    const payload: TraceTreeResponse = { trees: [] }
    mockFetch(stubResponse(payload))

    const result = await getTraceTree('run 1', '2026-05-15')

    expect(lastCall()[0]).toBe('/v1/runs/run%201/trace-tree?session_date=2026-05-15')
    expect(result).toEqual(payload)
  })

  it('getTraceTree omits the query when no session is given', async () => {
    mockFetch(stubResponse({ trees: [] }))

    await getTraceTree('run-1')

    expect(lastCall()[0]).toBe('/v1/runs/run-1/trace-tree')
  })

  it('getNodeValue builds the full address query with encoded run id', async () => {
    mockFetch(stubResponse(NODE_VALUE))

    const result = await getNodeValue('run 1', {
      nodeId: 'n1',
      sessionDate: '2026-05-15',
      componentPath: ['a', 'b'],
      outputPort: 'out',
    })

    expect(lastCall()[0]).toBe(
      '/v1/runs/run%201/values?node_id=n1&session_date=2026-05-15&component_path=a%2Cb&output_port=out',
    )
    expect(result).toEqual(NODE_VALUE)
  })

  it('getNodeValue omits component_path and output_port for a top-level, single-port node', async () => {
    mockFetch(stubResponse(NODE_VALUE))

    await getNodeValue('r1', {
      nodeId: 'n1',
      sessionDate: '2026-05-15',
      componentPath: [],
    })

    expect(lastCall()[0]).toBe(
      '/v1/runs/r1/values?node_id=n1&session_date=2026-05-15',
    )
  })

  it('listRuns omits the query when no strategy id is given', async () => {
    mockFetch(stubResponse({ runs: [] }))

    await listRuns()

    expect(lastCall()[0]).toBe('/v1/runs')
  })

  it('listRuns adds an encoded strategy_id query when given', async () => {
    mockFetch(stubResponse({ runs: [] }))

    await listRuns('s/1')

    expect(lastCall()[0]).toBe('/v1/runs?strategy_id=s%2F1')
  })
})

describe('POST wrappers', () => {
  it('saveStrategy POSTs the raw document as a JSON body', async () => {
    mockFetch(stubResponse({ strategy_id: DOC.strategy.id, version: 1 }))

    const result = await saveStrategy(DOC)

    const [url, init] = lastCall()
    expect(url).toBe('/v1/strategies')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
    expect(init?.body).toBe(JSON.stringify(DOC))
    expect(result).toEqual({ strategy_id: DOC.strategy.id, version: 1 })
  })

  it('validateStrategy POSTs the raw document to /v1/strategies/validate', async () => {
    const verdict: ValidateResponse = {
      ok: true,
      structural: [],
      semantic: [],
      runtime: [],
      warmup_sessions: 20,
    }
    mockFetch(stubResponse(verdict))

    const result = await validateStrategy(DOC)

    const [url, init] = lastCall()
    expect(url).toBe('/v1/strategies/validate')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify(DOC))
    expect(result).toEqual(verdict)
  })

  it('saveComponent POSTs the raw ComponentDefinition to /v1/components', async () => {
    const def: ComponentDefinition = {
      schema_version: '0.1.0',
      component_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      version: '1.0.0',
      name: 'Momentum',
      description: null,
      component_refs: [],
      implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
      exposed_inputs: [],
      exposed_outputs: [],
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
    mockFetch(stubResponse({ component_id: def.component_id, version: def.version }))

    const result = await saveComponent(def)

    const [url, init] = lastCall()
    expect(url).toBe('/v1/components')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify(def))
    expect(result).toEqual({ component_id: def.component_id, version: def.version })
  })

  it('runBacktest POSTs the request body to /v1/runs/backtest', async () => {
    const req: BacktestRunRequest = {
      strategy_id: DOC.strategy.id,
      strategy_version: 1,
      dataset_id: 'ds1',
      initial_cash: 100000,
    }
    mockFetch(stubResponse({ run_id: 'run-xyz' }))

    const result = await runBacktest(req)

    const [url, init] = lastCall()
    expect(url).toBe('/v1/runs/backtest')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify(req))
    expect(result).toEqual({ run_id: 'run-xyz' })
  })
})

describe('error path', () => {
  it('throws ApiClientError carrying the envelope code/message and status on non-2xx', async () => {
    mockFetch(
      stubResponse(
        { code: 'strategy_not_found', message: 'No such strategy.' },
        { ok: false, status: 404, statusText: 'Not Found' },
      ),
    )

    await expect(getRun('missing')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'strategy_not_found',
      message: 'No such strategy.',
      status: 404,
    })

    // And it is the concrete class, so callers can `instanceof` it.
    const error = await getRun('missing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiClientError)
  })

  it('getNodeValue throws ApiClientError carrying a served value-tap error', async () => {
    mockFetch(
      stubResponse(
        { code: 'ambiguous_output_port', message: 'Node has multiple output ports.' },
        { ok: false, status: 422, statusText: 'Unprocessable Entity' },
      ),
    )

    await expect(
      getNodeValue('r1', { nodeId: 'n1', sessionDate: '2026-05-15' }),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'ambiguous_output_port',
      message: 'Node has multiple output ports.',
      status: 422,
    })
  })

  it('falls back to status-derived defaults when the error body is not JSON', async () => {
    const response = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    } as unknown as Response
    mockFetch(response)

    await expect(listDatasets()).rejects.toMatchObject({
      code: 'http_error',
      message: 'Bad Gateway',
      status: 502,
    })
  })
})
