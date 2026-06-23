Codex completed an independent adversarial audit of M0 and recommended blocking M1 pending corrections.



Do not begin M1. Do not create application code. Do not commit yet.



Review the complete Codex audit and revise the M0 documentation into one internally coherent implementation contract. Treat the decisions below as founder-approved unless you identify a concrete contradiction that requires explanation.



\# Founder decisions



\## Strategy B cash semantics



The trend-filtered reference strategy must preserve fixed equal sleeves.



Example with four assets:



\* Each asset begins with a 25% sleeve.

\* Assets passing the trend filter retain their 25% sleeve.

\* Assets failing the filter receive zero.

\* Failed sleeves remain as cash.

\* Surviving assets are not renormalized to 100%.



Model this using an explicit operation such as fixed-weight allocation followed by a mask without renormalization. A separate future node may reweight surviving assets, but that is not Strategy B.



\## Execution policy



The only supported v0 policy is:



\* Evaluate close-based signals after session D closes.

\* Generate target allocations after evaluation.

\* Reconcile targets into orders in the engine.

\* Queue those orders for the next valid market session’s open.

\* Fill at D+1 open, where D+1 means the next valid exchange session rather than the next calendar day.



Represent execution policy explicitly so additional policies can be added later, but do not implement multiple v0 policies.



\## Components



Use standalone immutable `ComponentDefinition` documents and pinned `ComponentRef` references inside strategies.



A component definition must model:



\* stable component identity,

\* immutable component version,

\* schema version,

\* internal graph,

\* typed exposed inputs and outputs,

\* mappings between exposed ports and internal ports,

\* exposed parameter declarations,

\* parameter-binding semantics,

\* minimal provenance and fork ancestry.



A component reference must identify a specific immutable version.



Define:



\* missing-reference errors,

\* dependency resolution,

\* direct and transitive recursion rejection,

\* schema/component-version migration behavior,

\* hierarchical trace paths.



A future export bundle may embed all pinned dependencies for portability, but embedded definitions are not the primary persisted strategy model.



\## Forward/paper scope



For the MVP, forward/paper execution means deterministic incremental replay using local fixture or uploaded data, processed one market session at a time.



Do not introduce an external real-time or EOD data provider, network scheduling, or brokerage integration.



The same forward-driver contract should later admit a live data adapter.



\## Corporate actions



Explicitly exclude splits, dividends, symbol changes, mergers, delistings, and other corporate actions from v0.



Use deterministic synthetic or curated fixtures with no corporate actions. Fixtures must include unambiguous open and close prices; do not rely on adjusted-price behavior that is not documented.



\# Required corrections



\## 1. Replace the execution loop with a session-level event lifecycle



Separate:



\* market-session progression,

\* strategy evaluation schedule,

\* order queue,

\* fill events,

\* portfolio valuation,

\* stateful-node update cadence.



The documentation should define a lifecycle approximately as follows:



1\. Advance to the next market session.

2\. At session open, process orders due for that session.

3\. Apply transaction costs and update cash and holdings.

4\. At the defined valuation instant, mark the portfolio.

5\. At the strategy evaluation instant, if scheduled:



&#x20;  \* expose only data available as of that instant,

&#x20;  \* evaluate the strategy graph,

&#x20;  \* produce `PortfolioTargets`,

&#x20;  \* reconcile those targets against current portfolio state in the engine,

&#x20;  \* queue resulting orders for the next permitted fill event.

6\. Persist events, state, valuation, and structured traces.



Keep these timestamps separately modeled:



\* observation time,

\* data-availability time,

\* evaluation time,

\* signal time,

\* order-creation time,

\* scheduled-fill time,

\* actual-fill time,

\* valuation time.



Do not claim this makes look-ahead impossible. State that temporal access is structurally constrained and tested.



Do not claim backtest and forward outcomes cannot diverge. State that they share strategy semantics and node implementations while data and execution environment differences remain explicit.



The fixture contract must include:



\* exchange calendar,

\* timezone,

\* valid market sessions,

\* session open and close instants,

\* open and close prices,

\* data-availability timestamps,

\* at least one weekend or holiday boundary,

\* enough history for warm-up tests.



\## 2. Make both reference strategies fully typed and executable



Publish complete typed graphs for Strategy A and Strategy B.



Resolve these ambiguities explicitly:



\* `data.price` must receive or otherwise explicitly bind an `AssetSet`.

\* `AssetSet` must have deterministic canonical ordering or carry ordered asset identifiers where required.

\* Define deterministic ranking tie-breaking.

\* Define missing-value handling.

\* Define per-asset warm-up behavior.

\* Define mask behavior with missing values.

\* Define normalization behavior.

\* Define finite/non-negative weight requirements.

\* Define weight tolerance.

\* Define cap overflow and redistribution behavior.

\* Define cash as the explicit remainder `1 - sum(asset\_weights)` within tolerance.

\* Remove contradictory duplicate ownership of cash allocation.



The strategy graph must terminate in `PortfolioTargets`.



Remove user-graph order generation in v0. The engine owns:



`current portfolio + PortfolioTargets + execution policy → OrderList`



Do not retain both a proposed-order output node and an engine reconciliation path.



\## 3. Separate M1 structural validation from M2 semantic validation



M1 should cover:



\* schema-version structure,

\* field shape,

\* unique identifiers,

\* edge-reference integrity,

\* self-edge/cycle rules,

\* component-reference structure,

\* JSON round-trip,

\* preservation of `ui` metadata,

\* semantic equality that excludes `ui` metadata,

\* JSON Schema generation,

\* TypeScript type generation,

\* stale-codegen detection,

\* deterministic valid and invalid fixtures.



M2 should cover registry-dependent semantics:



\* known node types,

\* port existence,

\* required inputs,

\* parameter schemas,

\* type compatibility,

\* node-specific validation.



M1 may define an injected `NodeCatalog` protocol and test catalog as scaffolding, but must not create a closed central switch or real node implementations.



`ui` metadata must survive load, validation, serialization, and round-trip. It is excluded from runtime execution and semantic equality, not discarded.



\## 4. Resolve component milestone ordering



M1 must define the component document/reference contract and structural validation.



Component resolution and runtime evaluation must be implemented before any milestone depends on component execution.



Do not use a temporary flattening or “stub expansion” approach that contradicts compositional evaluation.



The component authoring/extraction UI may remain late, but component runtime support and component UI must be separate milestones.



Revise M1–M8 accordingly.



\## 5. Clarify the source-of-truth hierarchy everywhere



Use this hierarchy consistently:



1\. The versioned JSON strategy document is the persisted instance and semantic source of truth.

2\. Published JSON Schema is the language-neutral structural contract for a schema version.

3\. Pydantic is the v0 schema-authoring, generation, parsing, and validation implementation.

4\. Registry rules and explicit runtime invariants provide semantic validation.

5\. Generated TypeScript types consume the schema and are never manually maintained.



Replace wording that says “Pydantic is the canonical IR” with wording that makes this hierarchy explicit.



\## 6. Revise milestones



Correct at least these issues:



\* M1 must not require M2 registry behavior.

\* M2 and M4 must not both claim ownership of the same remaining node set.

\* M3 must not use a rebalance-only clock or temporary component expansion.

\* Split tracing construction from durable trace persistence/retrieval where appropriate.

\* Split M6 if API, migrations, persistence, versioning, and orchestration form too large a milestone.

\* Plan the registry-descriptor API and parameter-form metadata required by the editor before M7.

\* Separate component runtime/resolution from component authoring UI.

\* Define executable commands and acceptance tests as soon as repository scaffolding exists.



Keep the plan narrow. Remove built-in nodes not required for the two reference strategies unless they are foundational primitives genuinely required by the language.



\## 7. Fix overconfident statements



Search all documents for statements equivalent to:



\* look-ahead is impossible,

\* backtest and forward cannot drift,

\* consistency is free,

\* PostgreSQL migration is mechanical.



Replace them with technically accurate statements describing structural protections, explicit boundaries, remaining risks, and tests.



\## 8. Diagnose and propose a fix for the Claude hook failure



The audit found stale global Get-Shit-Done configuration referencing missing files such as:



\* `\~/.claude/hooks/gsd-check-update.js`

\* `gsd-context-monitor.js`

\* `gsd-statusline.js`



Inspect the actual global settings and confirm:



\* exact commands,

\* missing paths,

\* whether the integration is still intended,

\* safest cleanup.



Do not silently disable or alter global configuration. Report the exact proposed change separately for approval.



\## 9. Repository hygiene



Before committing:



\* verify every documented reference exists,

\* remove duplicate headings and passages,

\* compare CLAUDE.md and AGENTS.md for contradictions,

\* show the complete Git status,

\* identify the stale `origin/main \[gone]` relationship and recommend whether to remove or reconfigure it.



\# Required response



First, before editing, provide:



1\. Your assessment of each Codex blocking finding:



&#x20;  \* accept,

&#x20;  \* partially accept,

&#x20;  \* or reject,

&#x20;    with technical reasoning.



2\. A document-by-document correction plan.



3\. A revised milestone sequence.



4\. Any unavoidable founder decision still missing.



Then apply the approved documentation corrections only.



After editing:



\* show a concise diff summary,

\* list all claims and contradictions corrected,

\* verify both reference strategies as complete typed graphs,

\* verify the M1 readiness checklist,

\* do not begin M1,

\* do not commit until explicitly authorized.



