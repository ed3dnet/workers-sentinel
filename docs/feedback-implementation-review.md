# Website feedback implementation verification

Scope: the operator-approved framework-independent feedback SDK plan in session `0d00md-bud`, 2026-10-07. Targets: `packages/feedback-sdk`, Worker feedback routes and ProjectState lifecycle, dashboard feedback list/detail, README integrations. No deployment or npm publication is authorized by this implementation.

## Review ledger

| Round | Reviewer | Findings / disposition | Repairs and validation | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `general-purpose:feedback-adversary` | Picker removed click suppression during cleanup; feedback could commit during purge; README options/context/bundle mismatched code. Ordinary non-password form content was raised but is outside the agreed mandatory masks; owner-configured selectors and privacy responsibility remain documented. | Initial repairs applied; later implementation finalization is tightening picker and purge behavior and adding executable regressions. | FINDINGS |
| 2 | `general-purpose:feedback-review-round-2` | Private sibling overlays could be overpainted; README still described capture at Submit rather than Capture Screenshot. Reviewer also requested full corrupt-image decoding and decoded-pixel bounds, beyond the explicitly approved type/signature contract and explicitly deferred dimension policy. | Masks moved to rendered bitmap and later finalized against actual output dimensions. README capture consent corrected. Incomplete ad-hoc image parsers are being replaced with the approved strict raster type/magic-byte agreement contract and genuine valid image fixtures. Full decoder/pixel policy stays tracked as housekeeping, not an unresolved blocker for this scope. | FINDINGS |

Round 3 (`general-purpose:feedback-review-round-3`) returned FINDINGS for a late-upload-after-purge race: a reserved direct R2 put can finish after the prefix sweep/DO wipe, and failed compensation then has no GC alarm. The constructor reproduced that interleaving in a deterministic lifecycle test. Repair retains only a project-prefix tombstone and recurring cleanup alarm after purge, rejecting feedback and sweeping late R2 objects without restoring tenant rows. Round 4 (`general-purpose:feedback-review-round-4`) independently reproduced page `pointerup` activation during element selection. The constructor added capture-phase pointerup/pointercancel suppression and a real Chromium activation-counter assertion in both ESM and script fixtures; 14 SDK unit tests and both emitted-artifact browser tests pass after repair. Round 5 (`general-purpose:feedback-review-round-5`) returned **NO_ACTIONABLE_FINDINGS** for the current revised target. Review evidence was fresh read-only source inspection and checked-in regression assertions; executable tests were run separately by the constructor. Outcome: **CONVERGED** within approved AC1–6, not proof of correctness/security.

Five-round productivity checkpoint: concrete in-scope picker, privacy, documentation, and purge-race defects were closed with bounded repairs and repeatable checks; approved scope stayed stable. Full decoder/pixel policy and edge abuse controls stayed explicitly deferred rather than incrementally expanding the feature. The final round independently checked both last repairs and found no additional actionable in-scope issue.

## Environment diagnosis

Earlier Worker, dashboard, and SDK tests failed before collection (`ERR_RUNTIME_FAILURE` or filesystem error `-122`) using the default `/tmp`. Running with a repository-local temporary directory recovered the test runners without deleting unrelated temporary data:

```sh
mkdir -p .feedback-tmp
TMPDIR="$PWD/.feedback-tmp" pnpm --filter workers-sentinel test
TMPDIR="$PWD/.feedback-tmp" pnpm --filter @workers-sentinel/dashboard test
TMPDIR="$PWD/.feedback-tmp" pnpm --filter @workers-sentinel/feedback-sdk test
```

`.feedback-tmp/` is ignored. The pre-existing Worker regression baseline passed 327 tests in 35 files; the dashboard suite including feedback tests passed 21 tests in 6 files. Final integrated checks now execute successfully: SDK 14 unit tests; dashboard 21 component tests; emitted ESM/IIFE Chromium interaction and pixel-mask/annotation smoke tests; actual cross-origin SDK→Worker→dashboard bearer Blob preview flow; 11 black-box HTTP regressions; workspace typechecks and SDK/dashboard builds; npm dry-run pack inspection. Worker full suite before the final purge repair passed 339 tests in 37 files plus 3 WebAuthn-origin tests; the final late-put regression added one test and its focused 26-test lifecycle/attachment/purge run passes. The full post-purge repair suite passed 340 tests in 37 files. The separate 3-test WebAuthn-origin suite passed. After the pointerup repair, the 14 SDK unit tests, dual-install Chromium tests, actual browser-to-dashboard flow, and npm dry-run pack inspection passed again. Repository-wide Biome has no errors and only pre-existing warnings outside this feature. Language-server diagnostics timed out; successful TypeScript checks are the actual type evidence.

## Acceptance and evidence summary

| Criterion | Implemented outcome | Verification |
| --- | --- | --- |
| AC.1 | Framework-neutral ESM/types and standalone global installer; Shadow DOM launcher; composed-path final-element picker and Escape cleanup. | SDK 14 unit tests; Chromium emitted ESM/script smoke, click/down/up non-activation and restoration. |
| AC.2 | Explicit capture consent, best-effort page image and selected-element outline; opaque mandatory/custom bitmap masks; strict bounded metadata with timeout and separate omission choices. | Chromium mask/annotation pixel assertions and callback multipart inspection; unit timeout/error/cap/fallback/teardown checks. |
| AC.3 | DSN public-key submission only; bounded multipart; credential-less wildcard CORS; independent 100/hour quota. | Workerd auth/CORS/cap tests and 100/101 boundary with bidirectional event-quota independence. |
| AC.4 | Member-only raster download with controlled MIME/nosniff; shared quota, removal/retention/GC/purge, failed compensation and late-put cleanup. | Workerd feedback lifecycle and existing attachment regressions; full Worker 340 tests/37 files plus origins 3. |
| AC.5 | Project inbox keyset pagination, description/page/locator/geometry/metadata, explicit no-image state, bearer fetch and Blob URL cleanup. | Dashboard 21 tests; real browser website→Worker→dashboard decoded preview with asserted bearer header. |
| AC.6 | Documented local npm-tarball and hosted script integrations; conditional published CDN, configuration/nonce/privacy/limits/fallback. | Emitted-artifact browser fixtures, successful SDK build/types and npm pack dry-run, actual end-to-end script. |

Additional gates: black-box HTTP suite 11 passed; workspace typechecks passed; SDK/dashboard builds passed; repository Biome no errors (4 pre-existing warnings and 1 informational issue); `git diff --check` passed. Initial test-runner failures were resolved by local TMPDIR. Language-server diagnostic timeout remains a tooling limitation, not a passing result; TypeScript checks supply type evidence.

## Publishing boundary

The intended local artifact is `@workers-sentinel/feedback-sdk@0.1.0`. An npm registry lookup returned `E404` and `npm whoami` returned `ENEEDAUTH`; neither scope ownership nor publish permissions are confirmed. The package can be built/packed/installed locally and its standalone bundle hosted by the integrator. Registry install/CDN examples are explicitly conditional on a separately authorized publication. No npm publication was attempted.

## Deferred housekeeping

Canonical repository database: `/var/home/edwards/Projects/workers-sentinel/project.sqlite3`. Existing schema was inspected and entries deduplicated. Records 2 and 3 were committed, read back, and the handle closed:

- `feedback-edge-abuse-rate-limit`: per-project DSN submission limits are not submitter identity or distributed edge abuse controls.
- `feedback-image-decoded-pixel-limits`: byte caps and raster signatures do not guarantee decoded image resource limits or full corruption detection.

These are explicitly outside the accepted bounded release. The implementation must not claim pixel-perfect DOM capture, full image decoding validation, security proof, or registry availability.
