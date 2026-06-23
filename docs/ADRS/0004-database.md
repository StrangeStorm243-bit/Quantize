# ADR-0004: Database

- **Status:** Accepted (2026-06-23)
- **Related:** ADR-0001 (stack), ARCHITECTURE.md §4

## Context

The MVP is single-user and local, but the long-term product is multi-user and collaborative. We
need persistence for strategies (versioned), components (versioned), run results, and trace
artifacts. We want the simplest thing that works now without a painful migration later.

## Decision

**SQLite for the MVP, behind a thin repository layer, with a schema written to be PostgreSQL-ready.**

- Access the database through a **repository layer**, never with SQL scattered across the codebase.
  Swapping the backing store is then localized.
- **Postgres-ready schema discipline:**
  - UUID primary keys (not autoincrement integers).
  - Explicit UTC timestamps.
  - No SQLite-only features or types; portable column types.
  - **Migrations begin with the first persistence commit** (the milestone that introduces
    persistence, M7): a migration tool/dir is in place from that point — no ad-hoc `CREATE TABLE`
    drift. (Persistence does not exist in M1–M6, so there is nothing to migrate before then.)
- **The IR is stored as validated canonical JSON**, not exploded into per-node/per-edge tables.
  The document is the unit of truth; querying inside it is a future concern, not an MVP need.
- Entities: `strategies (id, version, ...)`, `components (component_id, version, ...)`,
  `runs (id, strategy_id, mode, ...)`, `results`/`traces` keyed by run + eval_date.

## Alternatives considered

- **PostgreSQL now:** the eventual target, but adds a service to run, configure, and back up for a
  single-user local MVP that does not need concurrency or server features. **Rejected as premature**
  — the discipline above **localizes** the later switch to the repository layer (it does not make it
  free; see Consequences).
- **Flat files / JSON on disk only:** simplest, but loses transactional integrity, versioning
  queries, and a clean path to multi-user. **Rejected.**
- **Document DB (e.g. Mongo):** the IR is document-shaped, but we also want relational integrity for
  versions/runs/provenance and a clean Postgres path. **Rejected** — SQLite→Postgres is the cleaner
  trajectory for this data.
- **ORM-heavy modeling of nodes/edges as rows:** over-normalizes a document that is meaningful only
  as a whole and couples storage to the node set. **Rejected** — store the validated JSON document.

## Consequences

- **Positive:** zero-setup local persistence; transactional; the repository + UUID/UTC/migrations
  discipline **localizes** a future Postgres move to one layer; storing canonical JSON keeps storage
  decoupled from the evolving node set.
- **Negative / accepted:** querying *inside* strategy documents is limited under SQLite — acceptable,
  since the MVP never needs it. Revisit when multi-user/search requirements actually appear.
- **The Postgres move is not free.** Even with the repository boundary it still requires authoring
  and testing migrations, validating dialect/type differences (e.g. JSON columns, UUID handling,
  constraints), and migrating existing data. "Localized," not "mechanical."
