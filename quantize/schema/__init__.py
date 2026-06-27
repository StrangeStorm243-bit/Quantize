"""IR schema (Pydantic v2 models).

The persisted JSON IR document is the semantic source of truth; these models are the v0
authoring/validation/JSON-Schema-generation implementation of it. Persist via the canonical
serializer (``to_ir_dict`` / ``to_ir_json``) — never a bare ``model_dump_json``.
"""

from quantize.schema.components import (
    ComponentDefinition,
    ComponentRef,
    ExposedParam,
    ExposedPort,
    Graph,
    GraphImplementation,
    Implementation,
)
from quantize.schema.document import (
    ExecutionPolicy,
    StrategyDocument,
    StrategyMeta,
    TransactionCosts,
)
from quantize.schema.nodes import (
    ComponentRefNode,
    Edge,
    NodeAdapter,
    NodeInstance,
    RegisteredNode,
)
from quantize.schema.primitives import (
    JS_MAX_SAFE_INT,
    RESERVED_COMPONENT_TYPE_ID,
    Count,
    EntityId,
    JsonObject,
    JsonValue,
    NodeId,
    NonNegativeFinite,
    PortName,
    RefId,
    RegisteredTypeId,
    SemVer,
    TypeId,
    Utc,
)
from quantize.schema.provenance import (
    ComponentForkRef,
    Provenance,
    StrategyForkRef,
    Visibility,
)
from quantize.schema.schedule import (
    Schedule,
    ScheduleDaily,
    ScheduleMonthly,
    ScheduleWeekly,
)
from quantize.schema.semantics import (
    component_semantic_projection,
    components_semantically_equal,
    documents_semantically_equal,
    semantic_projection,
)
from quantize.schema.serialization import to_ir_dict, to_ir_json
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    PortType,
    ScalarType,
    TimeSeriesType,
)
from quantize.schema.version import (
    CURRENT_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    is_supported_schema_version,
)

__all__ = [
    "CURRENT_SCHEMA_VERSION",
    "JS_MAX_SAFE_INT",
    "RESERVED_COMPONENT_TYPE_ID",
    "SUPPORTED_SCHEMA_VERSIONS",
    "AssetSetType",
    "ComponentDefinition",
    "ComponentForkRef",
    "ComponentRef",
    "ComponentRefNode",
    "Count",
    "CrossSectionType",
    "Edge",
    "EntityId",
    "ExecutionPolicy",
    "ExposedParam",
    "ExposedPort",
    "Graph",
    "GraphImplementation",
    "Implementation",
    "JsonObject",
    "JsonValue",
    "NodeAdapter",
    "NodeId",
    "NodeInstance",
    "NonNegativeFinite",
    "PortName",
    "PortType",
    "PortfolioTargetsType",
    "Provenance",
    "RefId",
    "RegisteredNode",
    "RegisteredTypeId",
    "ScalarType",
    "Schedule",
    "ScheduleDaily",
    "ScheduleMonthly",
    "ScheduleWeekly",
    "SemVer",
    "StrategyDocument",
    "StrategyForkRef",
    "StrategyMeta",
    "TimeSeriesType",
    "TransactionCosts",
    "TypeId",
    "Utc",
    "Visibility",
    "component_semantic_projection",
    "components_semantically_equal",
    "documents_semantically_equal",
    "is_supported_schema_version",
    "semantic_projection",
    "to_ir_dict",
    "to_ir_json",
]
