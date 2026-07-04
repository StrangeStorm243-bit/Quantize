"""M10.1: registry export primitives."""

import typing

from quantize.compatibility import is_compatible
from quantize.nodes import build_core_catalog
from quantize.registry.export import (
    PORT_TYPE_LATTICE,
    catalog_digest,
    compatible_pairs,
)
from quantize.schema.primitives import JsonObject
from quantize.schema.types import PortType, ScalarType

# --- lattice closure ---------------------------------------------------------------------------


def _construct_all_port_types() -> set[PortType]:
    """Every constructible PortType, derived from the union's variant model fields.

    Reads Pydantic fields (not raw ``__annotations__``, which are strings under
    ``from __future__ import annotations``): the ``kind`` literal is single-valued, and ``dtype``
    (when the variant has that field) enumerates the constructible dtypes. A future new variant
    or dtype changes this set — and must therefore break the closure test below.
    """
    union = typing.get_args(PortType)[0]  # the Union inside Annotated[Union, Field(...)]
    built: set[PortType] = set()
    for variant in typing.get_args(union):
        (kind,) = typing.get_args(variant.model_fields["kind"].annotation)
        dtype_field = variant.model_fields.get("dtype")
        if dtype_field is None:
            built.add(variant(kind=kind))
        else:
            for dtype in typing.get_args(dtype_field.annotation):
                built.add(variant(kind=kind, dtype=dtype))
    return built


def test_lattice_is_the_full_constructible_set() -> None:
    assert set(PORT_TYPE_LATTICE) == _construct_all_port_types()
    assert len(PORT_TYPE_LATTICE) == len(set(PORT_TYPE_LATTICE))  # no duplicates


def test_lattice_is_in_documented_sort_order() -> None:
    assert list(PORT_TYPE_LATTICE) == sorted(
        PORT_TYPE_LATTICE, key=lambda t: (t.kind, getattr(t, "dtype", None) or "")
    )


# --- compatible pairs --------------------------------------------------------------------------


def test_compatible_pairs_are_sound_reflexive_and_source_major_ordered() -> None:
    """Properties of the emitted relation (not a re-run of the function's own comprehension).

    Soundness: every emitted pair genuinely satisfies ``is_compatible``. Reflexivity: every
    lattice element pairs with itself. Ordering: pairs are source-major, destination-minor in
    lattice-index order. (Completeness — that no compatible pair is MISSING — is pinned by the
    exact 8-identities-plus-one-widening test below.)
    """
    index = {port_type: i for i, port_type in enumerate(PORT_TYPE_LATTICE)}
    pairs = compatible_pairs()

    # Soundness: nothing emitted that isn't actually compatible.
    assert all(is_compatible(source, destination) for source, destination in pairs)
    # Reflexivity: the identity pair is present for every lattice member.
    assert all((port_type, port_type) in pairs for port_type in PORT_TYPE_LATTICE)
    # Source-major, destination-minor ordering by lattice index.
    keys = [(index[source], index[destination]) for source, destination in pairs]
    assert keys == sorted(keys)


def test_compatible_pairs_is_eight_identities_plus_one_widening() -> None:
    pairs = compatible_pairs()
    assert len(pairs) == 9
    identities = [(s, d) for (s, d) in pairs if s == d]
    widenings = [(s, d) for (s, d) in pairs if s != d]
    assert len(identities) == 8
    assert widenings == [
        (
            ScalarType(kind="Scalar", dtype="Integer"),
            ScalarType(kind="Scalar", dtype="Number"),
        )
    ]


# --- catalog digest ----------------------------------------------------------------------------


def test_catalog_digest_distinguishes_one_character_bodies() -> None:
    body_a: JsonObject = {"node_types": [{"description": "a"}]}
    body_b: JsonObject = {"node_types": [{"description": "b"}]}
    assert catalog_digest(body_a) != catalog_digest(body_b)


def test_catalog_digest_is_stable_and_lowercase_hex() -> None:
    body: JsonObject = {"node_types": [{"description": "a"}]}
    digest = catalog_digest(body)
    assert catalog_digest(body) == digest  # deterministic across calls
    assert len(digest) == 64
    assert all(c in "0123456789abcdef" for c in digest)


# --- ImplementationCatalog.descriptors() -------------------------------------------------------


def test_catalog_descriptors_match_implementations_in_sorted_order() -> None:
    catalog = build_core_catalog()
    descriptors = catalog.descriptors()
    assert len(descriptors) == 13
    assert list(descriptors) == [impl.descriptor for impl in catalog.implementations()]
    keys = [(d.type_id, d.type_version) for d in descriptors]
    assert keys == sorted(keys)  # lexical (type_id, type_version); NOT semver ordering


# --- parameter-schema keyword guard ------------------------------------------------------------

_ALLOWED_SCHEMA_KEYWORDS = frozenset(
    {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "minimum",
        "exclusiveMinimum",
        "maximum",
        "minLength",
        "minItems",
        "uniqueItems",
        "items",
        "oneOf",
        "const",
        "default",
    }
)


def _collect_schema_keywords(node: object, acc: set[str]) -> None:
    """Collect JSON-Schema KEYWORDS only — never parameter names.

    The keys under a ``"properties"`` object are parameter NAMES (e.g. ``n``, ``max``), so we
    recurse into their VALUES only; likewise into the ``"items"`` value, each ``"oneOf"`` member,
    and a subschema-valued ``"additionalProperties"``. A naive all-keys walk would false-positive
    on a property literally named ``max``.

    This walk covers the keyword-bearing locations v0 descriptor schemas use. It does not descend
    into ``allOf``/``anyOf``/``not``/``patternProperties``/``$defs`` — but those self-protect: each
    of those container keywords is itself outside the allowed set, so its presence fails the guard
    directly. ``additionalProperties`` is the one allowed keyword that can carry a subschema, so we
    DO recurse into it (its boolean form is a no-op here). Widen this walk in lockstep if a future
    descriptor schema introduces another subschema-bearing keyword.
    """
    if not isinstance(node, dict):
        return
    acc.update(node.keys())
    properties = node.get("properties")
    if isinstance(properties, dict):
        for value in properties.values():
            _collect_schema_keywords(value, acc)
    if "items" in node:
        _collect_schema_keywords(node["items"], acc)
    one_of = node.get("oneOf")
    if isinstance(one_of, list):
        for member in one_of:
            _collect_schema_keywords(member, acc)
    additional = node.get("additionalProperties")
    if isinstance(additional, dict):
        _collect_schema_keywords(additional, acc)


def test_parameter_schema_keywords_within_supported_subset() -> None:
    collected: set[str] = set()
    for descriptor in build_core_catalog().descriptors():
        if descriptor.parameter_schema is None:
            continue
        _collect_schema_keywords(descriptor.parameter_schema.document, collected)
    assert collected <= _ALLOWED_SCHEMA_KEYWORDS, (
        f"unsupported schema keywords: {sorted(collected - _ALLOWED_SCHEMA_KEYWORDS)}"
    )


def test_keyword_guard_descends_into_subschema_additionalproperties() -> None:
    # A subschema-valued additionalProperties must not hide keywords from the guard: if the walk
    # skipped it, a future map-valued parameter could smuggle e.g. "format" onto the wire without
    # the deliberate reviewed widening. The keyword "format" must be collected (and, being outside
    # the allowed subset, would then fail the guard above).
    collected: set[str] = set()
    schema = {
        "type": "object",
        "additionalProperties": {"type": "string", "format": "date"},
    }
    _collect_schema_keywords(schema, collected)
    assert "format" in collected
    assert not (collected <= _ALLOWED_SCHEMA_KEYWORDS)
