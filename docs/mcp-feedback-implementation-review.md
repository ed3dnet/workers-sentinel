# Project MCP and feedback implementation review

## Original scope and review contract

Target: the integrated implementation in `packages/workers-sentinel/src/routes/mcp.ts`, `routes/feedback.ts`, `durable-objects/project-state.ts`, test-only token expiry hook in `durable-objects/auth-state.ts`, `src/index.ts`, worker package/lockfile dependencies; `packages/dashboard/src/views/Feedback.vue`, `FeedbackDetail.vue`, component tests/mocks; `docs/mcp.md`, root and feedback SDK README additions.

Outcome: API-token authenticated stateless MCP at one project URL with eleven read/ordinary triage tools, and a durable resolved/unresolved feedback backlog with filtering/pagination/actions and accurate DSN-derived hosted SDK setup.

Acceptance: AC.1 supported HTTP MCP initialization/tools, no batches, bounded/malformed transport failures, exact Origin and supplied Host checking; AC.2 API-token-only per-request auth and masked project/item isolation; AC.3 additive legacy status migration, persistence, filtered deterministic keyset paging and unchanged screenshot/lifecycle; AC.4 all documented non-destructive issue/feedback triage tools with actor attribution; AC.5 status/search/page sizing/load-more, list/detail actions and stale-response guards; AC.6 real project DSN-derived hosted script/init instructions with no unverified registry install claim.

Dimensions: correctness, authorization/origin boundaries, migration/data preservation, bounded parameters/output, pagination, races, runtime compatibility, docs and regression coverage.

Constraints: read-only reviewer; local isolated test data only; no deployment, production access, destructive MCP tools, cross-project discovery, OAuth implementation, token-scope redesign, SDK publication, unrelated dirty-tree repairs. Tests may execute only in local harness. Preserve pre-existing uncommitted SDK and self-feedback work. Verdict must be FINDINGS, NO_ACTIONABLE_FINDINGS, BLOCKED, or INCOMPLETE. Fresh review after each meaningful repair; original scope does not expand automatically.

Baseline: workspace `pnpm typecheck` passed; full worker suite 348 tests / 39 files passed; dashboard suite 33 tests / 7 files passed; `pnpm lint` passed with existing warnings; normal dashboard build passed and emitted `/sdk/feedback.js`, `/sdk/v0.1.0/feedback.js`, `/sdk/SKILL.md`. Tests need `TMPDIR=/var/tmp/workers-sentinel-vitest` because `/tmp` user quota was full. LSP pull diagnostics timed out; TypeScript checks provide static validation, not LSP results.

## Review ledger

| Round | Reviewer | Scope | Findings | Repairs | Validation | Verdict |
|---|---|---|---|---|---|---|
| 1 | `general-purpose:implementation-review-r1` | Integrated AC.1–AC.6 | FINDINGS: long title-sort cursor exceeds MCP's 300-character input cap; requested actor audit trails for snooze and feedback status | Confirmed cursor defect by failing long-title HTTP regression; issue-list cursor cap raised to 1024 (other cursor caps unchanged). Audit expansion classified out of original scope, not an implementation blocker: the plan requires actor attribution for issue status/comments but reuses existing snooze semantics and specifies no feedback audit store. | Failing reproduction then passing 11 focused worker tests, workspace typechecks, lint and diff checks | FINDINGS, dispositioned |
| 2 | `general-purpose:implementation-review-r2` | Revised integrated AC.1–AC.6; original boundaries unchanged | R2-MCP-TITLE-CURSOR-NEWLINE: title-sort cursor regex rejects returned multiline titles. Audit disposition accepted; no other actionable findings. | Independently reproduced with long multiline exception types; enabled dot-all matching only for issue-list cursor sort value, preserving max1024 and ID bounds. | Failing regression then passing 20 MCP/feedback/lifecycle tests; workspace types, lint and diff checks passed | FINDINGS, repaired |
| 3 | `general-purpose:implementation-review-r3` | Revised integrated AC.1–AC.6 including long/multiline cursor regression | No additional actionable findings within reviewed scope | None | Independently passed full worker349/39, dashboard33/7, SDK24/2, workspace types, lint(warnings only), diff checks and multiline cursor regression | NO_ACTIONABLE_FINDINGS |

Finding ledger: R1-CURSOR and R2-MCP-TITLE-CURSOR-NEWLINE are repaired and independently re-reviewed. R1-AUDIT is a deferred product enhancement rather than an in-scope repair: no new audit subsystem or snooze event schema was authorized; fresh Rounds2/3 agreed on the original scope boundary. Canonical repository database `/var/home/edwards/Projects/workers-sentinel/project.sqlite3` now contains verified open housekeeping records4 (OAuth-only client interoperability),5 (issue assignment),6 (snooze/feedback actor audit), preserving existing rows. All database handles closed.

## Final outcome: CONVERGED

Three fresh independent `general-purpose` review rounds; latest exact verdict **NO_ACTIONABLE_FINDINGS**. Final integrated validation:349 worker tests/39files,33 dashboard/7,24 SDK/2,3 separate WebAuthn origin tests; workspace typechecks; worker declaration build; workspace lint (four existing warnings and one info); whitespace checks; frozen-lockfile install; dashboard production build emits stable/versioned SDK assets and guide. Wrangler bundle dry-run passed without deployment.

Residual boundaries: no deployment/production verification or OAuth-only client integration; no universal mutation audit or assignment feature; no live browser end-to-end visual/accessibility audit in this change. Initial Vitest write/startup failures were traced to the user's `/tmp` quota and resolved using `/var/tmp/workers-sentinel-vitest`. LSP pull diagnostics timed out and were not counted as successful validation; TypeScript checks passed. Existing unrelated dirty work was preserved.

No deployment or production verification is authorized. Review convergence is evidence of no additional actionable findings within this scope, not proof of universal correctness or security.
