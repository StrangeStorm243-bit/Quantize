// Typed transport layer over the Quantize /v1 HTTP API (M11.2).
//
// One function per endpoint. Every request/response shape is imported from the GENERATED
// declarations (@quantize/quantize-api, @quantize/quantize-ir) — this module NEVER declares a
// domain type of its own (CLAUDE.md invariant 4). It is pure transport + typing: no numerical,
// portfolio, or compatibility logic lives here (invariant 5). All URLs are relative /v1/... so the
// Vite dev proxy (D3) — and a future same-origin deployment — resolves them with no CORS.
import type {
  ApiError,
  BacktestRunRequest,
  ComponentList,
  ComponentSaved,
  DatasetList,
  DatasetStored,
  DatasetUpload,
  ForwardRunRequest,
  MetaResponse,
  NodeCatalogResponse,
  RunCreated,
  RunList,
  RunRecordResponse,
  StrategyList,
  StrategySaved,
  TraceResponse,
  TraceTreeResponse,
  ValidateResponse,
  VersionList,
} from '@quantize/quantize-api'
import type {
  ComponentDefinition,
  StrategyDocument,
} from '@quantize/quantize-ir'

/**
 * A non-2xx response from the API, carrying the parsed {@link ApiError} envelope's stable machine
 * `code`, its human `message`, and the HTTP `status`. Thrown by every client function on failure.
 */
export class ApiClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
  }
}

/**
 * The display string for a thrown value. {@link ApiClientError} extends `Error`, so its human
 * `message` is covered by the `Error` branch — there is no separate `ApiClientError` case to write.
 * (Callers that need the machine `code` read `ApiClientError` directly; this is for plain display.)
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// The single fetch path: relative URL in, parsed typed JSON out. On non-2xx it parses the uniform
// { code, message } error envelope and throws ApiClientError; a non-JSON error body degrades to
// sensible defaults rather than masking the failure.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let code = 'http_error'
    let message = response.statusText || `HTTP ${response.status}`
    try {
      const body = (await response.json()) as Partial<ApiError>
      if (typeof body.code === 'string') {
        code = body.code
      }
      if (typeof body.message === 'string') {
        message = body.message
      }
    } catch {
      // Non-JSON error body (e.g. a proxy 502) — keep the status-derived defaults.
    }
    throw new ApiClientError(code, message, response.status)
  }
  return (await response.json()) as T
}

// A JSON POST init. The strategy save/validate endpoints take the RAW IR document (not a wrapper),
// so callers pass the document itself as `body`.
function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// --- Service identity & node catalog -------------------------------------------------------------

export function getMeta(): Promise<MetaResponse> {
  return request<MetaResponse>('/v1/meta')
}

export function getNodeCatalog(): Promise<NodeCatalogResponse> {
  return request<NodeCatalogResponse>('/v1/node-types')
}

// --- Strategies ----------------------------------------------------------------------------------

export function listStrategies(): Promise<StrategyList> {
  return request<StrategyList>('/v1/strategies')
}

// POST takes the raw StrategyDocument as the request body (no envelope).
export function saveStrategy(doc: StrategyDocument): Promise<StrategySaved> {
  return request<StrategySaved>('/v1/strategies', postJson(doc))
}

export function listStrategyVersions(id: string): Promise<VersionList> {
  return request<VersionList>(`/v1/strategies/${encodeURIComponent(id)}/versions`)
}

// The response is the raw persisted IR JSON → typed as StrategyDocument.
export function loadStrategyVersion(
  id: string,
  version: number,
): Promise<StrategyDocument> {
  return request<StrategyDocument>(
    `/v1/strategies/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`,
  )
}

// Run-faithful validation: POST the raw document, receive per-layer diagnostics.
export function validateStrategy(doc: StrategyDocument): Promise<ValidateResponse> {
  return request<ValidateResponse>('/v1/strategies/validate', postJson(doc))
}

// --- Components ----------------------------------------------------------------------------------

export function listComponents(): Promise<ComponentList> {
  return request<ComponentList>('/v1/components')
}

// POST takes the raw ComponentDefinition as the request body (no envelope), mirroring saveStrategy.
// The endpoint is idempotent (200 on an identical re-save; 409 on a divergent one at the same version).
export function saveComponent(def: ComponentDefinition): Promise<ComponentSaved> {
  return request<ComponentSaved>('/v1/components', postJson(def))
}

// The response is the raw persisted component IR JSON → typed as ComponentDefinition.
export function loadComponentVersion(
  id: string,
  version: string,
): Promise<ComponentDefinition> {
  return request<ComponentDefinition>(
    `/v1/components/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`,
  )
}

// --- Datasets ------------------------------------------------------------------------------------

export function uploadDataset(upload: DatasetUpload): Promise<DatasetStored> {
  return request<DatasetStored>('/v1/datasets', postJson(upload))
}

export function listDatasets(): Promise<DatasetList> {
  return request<DatasetList>('/v1/datasets')
}

export function getDataset(id: string): Promise<DatasetStored> {
  return request<DatasetStored>(`/v1/datasets/${encodeURIComponent(id)}`)
}

// --- Runs ----------------------------------------------------------------------------------------

export function runBacktest(req: BacktestRunRequest): Promise<RunCreated> {
  return request<RunCreated>('/v1/runs/backtest', postJson(req))
}

export function runForward(req: ForwardRunRequest): Promise<RunCreated> {
  return request<RunCreated>('/v1/runs/forward', postJson(req))
}

// Optional strategy filter → `?strategy_id=` query (encoded); omitted when absent.
export function listRuns(strategyId?: string): Promise<RunList> {
  const query =
    strategyId === undefined
      ? ''
      : `?strategy_id=${encodeURIComponent(strategyId)}`
  return request<RunList>(`/v1/runs${query}`)
}

export function getRun(runId: string): Promise<RunRecordResponse> {
  return request<RunRecordResponse>(`/v1/runs/${encodeURIComponent(runId)}`)
}

export function getTrace(
  runId: string,
  sessionDate: string,
): Promise<TraceResponse> {
  return request<TraceResponse>(
    `/v1/runs/${encodeURIComponent(runId)}/trace?session_date=${encodeURIComponent(sessionDate)}`,
  )
}

// The served per-instant trace tree (M13.6) — the same stored stream as getTrace, grouped by the
// server's build_trace_trees. The optional session filter mirrors the endpoint contract (omitted →
// the whole run). This is the single grouping implementation; the client no longer regroups.
export function getTraceTree(
  runId: string,
  sessionDate?: string,
): Promise<TraceTreeResponse> {
  const query =
    sessionDate === undefined
      ? ''
      : `?session_date=${encodeURIComponent(sessionDate)}`
  return request<TraceTreeResponse>(
    `/v1/runs/${encodeURIComponent(runId)}/trace-tree${query}`,
  )
}
