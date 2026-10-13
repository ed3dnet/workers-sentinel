---
name: proptest-loop
description: Use to drive the property-testing discovery loop in this repository — build fast-check + vitest property suites against the worker and dashboard, find correctness bugs, and extract reviewable fixes. Trigger on asks to proptest, stress invariants, fuzz parsers, or find correctness bugs.
polytoken: true
---

# Property-testing discovery loop (workers-sentinel)

Run these instructions in this repository. Incorporate any maintainer concerns and suggested targets provided in the conversation. Own the investigation and keep exploring as findings suggest new targets.

## 1. Objective and deliverables

Find correctness bugs by building and running property-testing machinery. The framework is **fast-check v3** under **vitest 4**; worker tests execute inside a real workerd via `@cloudflare/vitest-plugin`. Prioritize executable checks that explore many inputs and operation histories without spending LLM tokens analyzing each case.

Maintain a **`proptest/discovery` branch** containing generators, operation sequences, reference models, invariants, and investigative tests (worker side: `packages/workers-sentinel/test/proptest/*.test.ts`; dashboard side: `packages/dashboard/src/__tests__/`). This suite can be large, repetitive, and slow. Its correctness matters; production-level performance and polish usually don't. Run it locally and retain reproducible failures.

For each confirmed bug, produce a focused branch **`proptest/fix/<slug>` off `main`** containing a deterministic regression test (fixed inputs, **no fast-check import**) and a minimal fix — independently reviewable without the discovery suite. Bugs found through code inspection qualify too. Keep ambiguous findings separate from established contract violations.

## 2. Harness constraints (read first)

- **Shared workerd, shared storage.** The worker suite runs as one shared worker (`maxWorkers: 1, isolate: false`) and DO storage persists across tests within a run. Stateful properties must mint isolated fixtures per case (unique emails / project ids / slugs from the generator) and never assume a pristine Durable Object. Transient "invalidating this Durable Object" restarts are a known flake — `test/utils.ts` has retry helpers.
- **Import pure modules directly.** High-volume cases import from `src/lib/*` and call functions — no HTTP. Use `SELF.fetch` only for low-volume end-to-end invariants (tens of cases, not thousands; SELF latency has a history of cumulative anomalies — see AGENTS.md).
- **argon2 costs ~250ms CPU per hash.** Never build volume properties over register/login/password hashing. Test auth validation and normalization as pure logic; keep real-argon2 flows to tiny case counts.
- **fast-check is a discovery-branch devDependency** (`pnpm --filter @workers-sentinel/worker add -D fast-check`, likewise the dashboard package where needed). Fix branches and `main` never depend on it.
- **No Node APIs in worker tests** (no `Buffer`, no `node:*`) — use Web APIs (`TextEncoder`, `crypto.randomUUID`, `atob`/`btoa`). fast-check itself is pure JS and workerd-safe; if a workerd incompatibility ever appears, fall back to a small hand-rolled seeded generator rather than abandoning the loop.
- **Dashboard DOM code needs jsdom.** The suite default is happy-dom; anything that needs a real DOM (e.g. DOMPurify-based sanitization) must run under the per-file jsdom environment — follow the convention in `src/__tests__/issue-detail.test.ts`.
- **Seeds and reproductions.** fast-check shrinks and prints the counterexample and seed on failure. Record both in the findings ledger, but encode every kept reproduction as a fixed-input test — a seed's meaning changes whenever generators change.
- **Hooks.** lefthook pre-commit runs the full worker suite whenever `packages/workers-sentinel/{src,test}/**` is staged. Iteration commits on the discovery branch may deliberately use `--no-verify` for speed; **every fix-branch commit must pass its hooks**, and pushing `main` runs the black-box integration suite.
- **Style.** Biome: tabs, single quotes, semicolons, 100-column width.
- **Contract sources.** AGENTS.md is the written contract (normalization rules, byte budgets, endpoint semantics, pagination conventions). Where it is silent, code plus existing tests are the de-facto contract. Do not invent a specification to make a test pass — surface the ambiguity to the operator instead.

## 3. Direct the investigation

Recognize testing opportunities from code behavior, not just names: derived state, incremental counters, secondary indexes, state transitions, aliasing, and ordering dependencies across module boundaries (route → DO handler → serializer).

Lenses, applied throughout:

- **History-dependent behavior:** identical logical contents can conceal different caches, counters, and deferred work. Vary how states are reached and when they are observed.
- **Generator distribution:** omitted interactions are unreachable; rare ones stay rare. Inspect what the generators actually produce before trusting run volume.
- **Oracle independence:** express the expected behavior independently. Never build a model by calling the production helper — model incremental state by full recomputation, a streaming consumer by its one-shot equivalent, a paginated query by fetching everything and sorting.
- **Search feedback:** treat zero findings as a coverage problem first. Calibrate harnesses with deliberate mutations (omit an invalidation, skip a cap, shift a boundary by one) and confirm the harness catches them; revert the mutation.
- **Adaptive allocation:** get one promising harness running early, keep productive searches executing while developing others; maintain breadth across independent mechanisms while deepening the targets that produce failures.

Prioritize complex implementations with simple correctness models — an incrementally maintained structure modeled by full recomputation, a streaming processor by its one-shot equivalent, a paginated query by fetch-everything-and-sort.

Delegate with @subagent:researcher for local-code and web lookups to protect main context (the operator prefers the strongest available long-context model for research delegation). Use bounded general-purpose subagents for build-and-run work, each in its own `git worktree` when they mutate state concurrently. Track a findings ledger on the discovery branch: active targets, runnable commands, observed coverage, seeds, unresolved leads — so investigations resume without duplication.

## 4. Recognize testing opportunities

Survey the code first — `src/lib/`, `src/durable-objects/`, `src/routes/` (including the `/api/0` surface), and the dashboard package — and match what you find to these shapes. The target list is an **output** of this loop, not an input; where a mechanism fits no shape, derive the property it deserves from its contract.

**Partial oracles and solution checking:** exploit outputs that are cheaper to validate than to compute — check edges, ordering, preserved fields, and index consistency independently. Distinguish soundness from completeness: every emitted row being valid does not establish that every valid row was emitted. Combine these checks with reference models, metamorphic relations, and small-instance exhaustive oracles.

- **Collections, indexes, interning, deduplication — model-based differential testing:** compare against a plain array/map/set model. Exercise overwrite, deletion, reinsertion, collisions, id reuse, duplicate inputs, and empty/singleton states; check contents, lookup results, multiplicity, and agreement between primary and secondary indexes.
- **Caches, incremental counters, derived summaries — recomputation oracles:** compare incrementally maintained state with independent full recomputation. Warm it, mutate through every relevant API, query again; include changes that preserve size while altering contents, and transitive dependencies.
- **Graphs, traversals, dependency analysis:** compare reachability and membership with a straightforward traversal or small-instance enumeration; generate cycles, diamonds, shared nodes, disconnected parts, and deletion holes where representable.
- **Transformations, rewrites, sanitizers — semantic preservation:** evaluate original and transformed forms against a small model of the intended meaning; check required fields survive, forbidden content is removed, and equivalence holds where promised. Equivalent outputs need not be structurally identical.
- **State machines, transactions, staged writes — fault injection, failure atomicity, recovery invariants:** generate failure schedules alongside operations and make a dependency fail on call *k*; exercise rollback, retry, partial progress, and continued use after errors; check intermediate state against the operation's actual contract, including atomicity where promised.
- **Parsers, serializers, encoders — grammar-aware generation and round trips:** generate structured valid inputs for encode/decode and parse/print round trips; separately generate malformed, truncated, boundary-sized, and unusual external inputs to seek throws and incorrect acceptance. Check semantic preservation where normalization is intentional — and don't normalize away meaningful differences.
- **Streaming and incremental processors — chunk-boundary invariance:** anything that consumes a byte/text stream in chunks must produce identical outcomes for every split of the same stream — one-shot, byte-at-a-time, splits inside each syntactic element, multibyte characters straddling chunk edges.
- **Representation boundaries — boundary-value analysis:** empty/singleton inputs, integer extrema, narrowing conversions, overflow, sentinels, and inclusive/exclusive range edges. Model size/offset arithmetic with wider intermediates; for text, distinguish byte offsets from code points.
- **Equality, hashing, ordering, normalization:** generate equivalent values through different construction histories and representations; check that equal values hash and order equally, and that canonicalization preserves meaning and is stable when repeated. Generate equivalent pairs deliberately — independently random pairs seldom compare equal.
- **Bulk APIs, alternate implementations, execution modes — metamorphic testing:** compare batch operations with equivalent individual operations, incremental construction with rebuilding, and alternate API paths that promise equivalent results. Vary insertion order, traversal order, chunk boundaries, and configuration independently when they should not affect semantics.
- **Sharing, snapshots, copy-on-write:** branch from shared state, mutate each branch, and check isolation or propagation as promised, including mutations after reads have initialized lazy state.
- **Validators and invariant auditors:** construct a valid object, introduce a targeted defect, and check that the auditor detects it — and that it accepts valid objects. Vary the corruption's location and surrounding structure; test the checker itself wherever other properties rely on it.

Use bounded exhaustive enumeration when small domains make it practical, alongside randomized generation — random sampling does not exhaust the state space. Keep checks cheap enough to run extensively, and separate expensive small-instance oracles from larger stress runs.

## 5. Build effective generators and operation-sequence tests

- **Model-based stateful testing** with `fc.commands` and the model/Command pattern for stateful surfaces: model the persisted state as plain maps/arrays, replay the same operation sequence against production, compare observable state after every step.
- **Constructive generation, near-valid inputs:** build valid inputs deliberately; derive invalid variants by violating exactly one constraint (a dangling reference, an inconsistent length, a duplicate identifier, a truncated encoding). Avoid `fc.pre` rejection filters — design the arbitrary to produce the class directly.
- **Small key/value domains** to force overwrites, duplicate resends, shared references, and reuse of removed ids; include fresh, absent, and previously-removed identifiers in the same pool. Use unequal replacement values, so stale results stay observable.
- **Targeted patterns embedded in random prefixes/suffixes:** warm → mutate → query; resend after drop; allocate → free → reuse; populate → prune → repopulate; failed operation → continued use.
- **Swarm/mix diversification:** vary enabled operation subsets and weights across cases (mutation-heavy, read-heavy, growth-heavy); inspect traces for mostly-empty states and unexercised variants.
- **Text boundaries:** multibyte UTF-8, combining sequences, and escapes — split streams at every byte offset around multibyte characters; distinguish byte offsets from code points wherever indexing exists.
- **Bounded exhaustive enumeration** for small domains (short structured strings, clamp tables, enumerated vocabularies) alongside randomized generation.
- **Volume calibration:** pure in-process targets can run thousands of cases; anything paying a round trip (HTTP, DO fetch) tens. Keep per-case work cheap; separate expensive small-instance oracles from broad stress runs. Watch vitest timeouts (test files carry raised timeouts where argon2 appears — don't inherit that need).
- **Determinism:** no hidden randomness inside test bodies; derive everything from the fast-check seed so replay is exact.

## 6. Investigate failures

Reproduce each failure and find the first divergence. Check both sides: the implementation *and* the oracle (adapters, normalization, comparison logic can hide or invent differences). Establish the concrete contract violation — stale data, lost/duplicated rows, wrong ordering, drift, idempotence break, unexpected throw — against AGENTS.md or the de-facto contract. A data-structure-level violation is sufficient; an end-to-end user reproduction is not required.

Generalize the minimized witness into a failure family in the generators; vary the suspected conditions individually and in combination. Run **variant analysis** across alternate entry points that maintain the same invariant — here a mechanism often exists in several places (HTTP route, DO handler, `/api/0` serializer, dashboard store); dispatch leads to subagents. Cluster findings by root cause before deciding bug/fix boundaries.

Reduce every kept failure to a readable deterministic vitest test with explicit expected behavior, and confirm it fails against unmodified production for the claimed reason. A seed or timeout disagreement alone is not a deliverable.

## 7. Extract reviewable fixes

**Security-sensitive findings** (auth bypass, injection, redaction gaps, tenancy leaks): report to the operator privately first. This repo lives on GitHub and has a security-analysis history — do not push exploit-grade reproductions or fixes to any branch without clearance.

One `proptest/fix/<slug>` branch per distinct bug: standalone deterministic regression test + smallest complete fix. Verify the regression fails before the fix and passes after; re-run the discovery generators (including fresh cases) against the fix inside the discovery worktree; run the relevant gates (`just test` / package suites, `pnpm typecheck`, `pnpm lint`) with hooks live. Then merge the validated fix into the discovery branch and continue searching past the resolved failure.

Write each fix around the concrete trigger, wrong behavior, expected behavior, and repair — understandable to a reviewer who has never seen this skill. State validation accurately; distinguish demonstrated contract violations from unproven application-level impact.

**Surface findings with recommendations — the ledger is a record, never the reporting channel.** Every confirmed bug, recorded divergence, and consequential ambiguity reaches the operator with a recommendation: severity, the suggested fix shape, and its trade-offs (including the cost of NOT fixing). Raise findings as they land — or batched at session close at the latest — and when a decision gates further work, ask with the recommended option first. A finding that lives only in the ledger is an unreported finding.

Keep exploring. Feed confirmed failures and suspicious patterns back into target selection, and bring the operator findings, consequential ambiguities, and questions requiring repository context as they arise.
