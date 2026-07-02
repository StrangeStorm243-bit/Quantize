"""M7.4: strategy/component repositories — round-trip, immutability, corruption, gating."""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from pathlib import Path

import pytest

from quantize.persistence.database import Database
from quantize.persistence.documents import (
    ComponentRepository,
    StrategyKey,
    StrategyRepository,
)
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    UNSUPPORTED_ARTIFACT_VERSION,
    PersistenceError,
)
from quantize.persistence.serialize import content_hash, model_bytes
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "q.db")
    yield database
    database.close()  # deterministic close: Windows file locks vs tmp_path teardown


def _strategy() -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture("strategy_a"))


def _component() -> ComponentDefinition:
    return ComponentDefinition.model_validate(load_fixture("component_momentum"))


def test_save_load_round_trip_is_exact(db: Database) -> None:
    repository = StrategyRepository(db)
    document = _strategy()
    snapshot = copy.deepcopy(document)
    key = repository.save(document)
    assert key == StrategyKey(document.strategy.id, document.strategy.version)
    loaded = repository.load(key.strategy_id, key.version)
    assert loaded == document  # fresh object, full equality
    assert loaded is not document
    assert model_bytes(loaded) == model_bytes(document)  # byte-identical canonical form
    assert document == snapshot  # save never mutated the input


def test_byte_round_trip_preserves_ui_and_extensions_key_order(db: Database) -> None:
    # The idempotency scheme rides on to_ir_json(model_validate(bytes)) == bytes — including
    # arbitrary ui.*/extensions key order (insertion order must survive validation).
    payload = load_fixture("strategy_a")
    payload["extensions"] = {"zeta": 1, "alpha": {"nested_z": True, "nested_a": False}}
    payload["nodes"][0]["ui"] = {"y": 2.0, "x": 1.0, "colour": "teal"}
    document = StrategyDocument.model_validate(payload)
    first = model_bytes(document)
    revalidated = StrategyDocument.model_validate(json.loads(first.decode("utf-8")))
    assert model_bytes(revalidated) == first
    repository = StrategyRepository(db)
    key = repository.save(document)
    assert model_bytes(repository.load(key.strategy_id, key.version)) == first


def test_duplicate_identical_save_is_idempotent(db: Database) -> None:
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    assert repository.save(_strategy()) == key
    assert len(repository.list_strategies()) == 1


def test_divergent_save_under_same_key_is_a_conflict(db: Database) -> None:
    repository = StrategyRepository(db)
    repository.save(_strategy())
    payload = load_fixture("strategy_a")
    payload["strategy"]["description"] = "silently different"
    with pytest.raises(PersistenceError) as caught:
        repository.save(StrategyDocument.model_validate(payload))
    assert caught.value.code == ARTIFACT_CONFLICT


def test_missing_artifact_is_structured(db: Database) -> None:
    with pytest.raises(PersistenceError) as caught:
        StrategyRepository(db).load("00000000-0000-0000-0000-000000000000", 1)
    assert caught.value.code == ARTIFACT_NOT_FOUND


def test_corrupt_json_fails_structured(db: Database) -> None:
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    with db.transaction() as connection:  # test-only raw access
        connection.execute(
            "UPDATE strategies SET document = '{not json', content_hash = ? WHERE version = ?",
            (content_hash(b"{not json"), key.version),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load(key.strategy_id, key.version)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_hash_mismatch_fails_structured(db: Database) -> None:
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    with db.transaction() as connection:
        connection.execute("UPDATE strategies SET content_hash = 'tampered'")
    with pytest.raises(PersistenceError) as caught:
        repository.load(key.strategy_id, key.version)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_domain_validation_failure_fails_structured(db: Database) -> None:
    from quantize.schema.version import CURRENT_SCHEMA_VERSION

    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    broken = json.dumps({"schema_version": CURRENT_SCHEMA_VERSION, "not": "a strategy"})
    with db.transaction() as connection:
        connection.execute(
            "UPDATE strategies SET document = ?, content_hash = ?",
            (broken, content_hash(broken.encode("utf-8"))),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load(key.strategy_id, key.version)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_unsupported_payload_schema_version_is_gated(db: Database) -> None:
    # The PAYLOAD is the version source of truth (Codex blocker): tamper it (hash and row kept
    # consistent) -> unsupported, never a loaded domain object.
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    rows = db.query("SELECT document FROM strategies")
    payload = json.loads(str(rows[0][0]))
    payload["schema_version"] = "999.0.0"
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with db.transaction() as connection:
        connection.execute(
            "UPDATE strategies SET document = ?, schema_version = '999.0.0', content_hash = ?",
            (raw, content_hash(raw.encode("utf-8"))),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load(key.strategy_id, key.version)
    assert caught.value.code == UNSUPPORTED_ARTIFACT_VERSION


def test_row_and_payload_schema_version_must_agree(db: Database) -> None:
    # Row metadata diverging from the payload is CORRUPTION, not a version problem.
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    with db.transaction() as connection:
        connection.execute("UPDATE strategies SET schema_version = '999.0.0'")
    with pytest.raises(PersistenceError) as caught:
        repository.load(key.strategy_id, key.version)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_unsupported_schema_version_is_rejected_at_save(db: Database) -> None:
    # Pydantic accepts any well-formed SemVer; the repository must refuse to persist an
    # unsupported one (invalid_artifact), for strategies and components alike.
    from quantize.persistence.errors import INVALID_ARTIFACT

    payload = load_fixture("strategy_a")
    payload["schema_version"] = "999.0.0"
    with pytest.raises(PersistenceError) as caught:
        StrategyRepository(db).save(StrategyDocument.model_validate(payload))
    assert caught.value.code == INVALID_ARTIFACT
    component = load_fixture("component_momentum")
    component["schema_version"] = "999.0.0"
    with pytest.raises(PersistenceError) as caught:
        ComponentRepository(db).save(ComponentDefinition.model_validate(component))
    assert caught.value.code == INVALID_ARTIFACT


def test_listings_expose_only_plain_values(db: Database) -> None:
    repository = StrategyRepository(db)
    key = repository.save(_strategy())
    summaries = repository.list_strategies()
    assert len(summaries) == 1
    summary = summaries[0]
    # Backend never leaks: domain objects + plain values only.
    assert isinstance(summary.strategy_id, str)
    assert isinstance(summary.version, int)
    assert isinstance(summary.name, str)
    assert isinstance(summary.schema_version, str)
    assert isinstance(summary.saved_at, str)
    assert repository.list_versions(key.strategy_id) == (key.version,)
    assert repository.list_versions("00000000-0000-0000-0000-000000000000") == ()


def test_stored_version_columns_are_recorded(db: Database) -> None:
    repository = StrategyRepository(db)
    document = _strategy()
    repository.save(document)
    rows = db.query("SELECT schema_version, content_hash, document FROM strategies")
    schema_version, digest, raw = rows[0]
    assert schema_version == document.schema_version  # exact version stored with the artifact
    assert isinstance(raw, str)
    assert digest == content_hash(raw.encode("utf-8"))  # hash binds the EXACT stored bytes


def test_component_round_trip_and_conflict(db: Database) -> None:
    repository = ComponentRepository(db)
    definition = _component()
    key = repository.save(definition)
    assert repository.save(definition) == key  # idempotent
    loaded = repository.load(key.component_id, key.version)
    assert loaded == definition
    assert model_bytes(loaded) == model_bytes(definition)
    payload = load_fixture("component_momentum")
    payload["description"] = "divergent"
    with pytest.raises(PersistenceError) as caught:
        repository.save(ComponentDefinition.model_validate(payload))
    assert caught.value.code == ARTIFACT_CONFLICT
    summaries = repository.list_components()
    assert [(s.component_id, s.version) for s in summaries] == [(key.component_id, key.version)]
