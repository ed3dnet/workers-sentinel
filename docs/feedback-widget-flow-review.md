# Feedback widget flow update — 2026-10-07

## Authorized behavior

The operator approved two changes after reviewing real feedback on Sentinel's dashboard: opening the launcher starts element selection without a dialog; selection automatically captures a masked screenshot before showing the pre-populated form. Capture failure warns without blocking Send. After success, the widget supports another report without reloading.

This changes the earlier manual-capture/text-only-confirmation workflow; submission remains an explicit Send action, and metadata-hook omission still requires a separate choice. Mandatory privacy masks, image bounds, credential-less public submission, protected reads, and storage behavior remain unchanged.

## Implementation and verification

- SDK selection/capture waiting states support Escape/Cancel and generation-guarded teardown.
- The form opens after capture resolves, with locator and preview or a warning; reselect retains description and captures a fresh target.
- Success offers Close and Send another report, resetting target, image, description, and metadata state.
- Documentation and the local end-to-end fixture follow the revised workflow.
- SDK: 24 tests passed; typecheck, ESM/IIFE/declarations build, and scoped Biome passed.
- Chromium: both emitted entrypoints passed selection-first, Escape, automatic capture, reselect, privacy-mask/annotation pixels, metadata, and sequential reports. Disabled screenshots and explicit metadata omission passed.
- Worker: 342 tests/38 files passed. Dashboard: 24 tests/7 files passed. Workspace typechecks and dashboard/hosted asset build passed.
- Actual isolated local browser-to-Worker-to-dashboard test passed: cross-origin submission, stored callback metadata, anonymous screenshot denial, bearer-authenticated screenshot retrieval, and Blob preview.
- Default temporary storage failed with write error -122; rerun using repository-local TMPDIR passed. The old inactive verification service was stopped and replaced with a fresh isolated local Worker.

## Independent review ledger

| Round | Reviewer | Findings / repairs | Validation | Verdict |
|---|---|---|---|---|
| 1 | fresh general-purpose | A throwing onSubmit callback after 201 caused both success and failure notifications. Independently reproduced with a failing regression (2 calls instead of 1), repaired by isolating notification exceptions from submission results. A stale self-feedback README paragraph was corrected to automatic capture. | SDK 21 tests, typecheck, Biome, and dual-entrypoint Chromium passed after repairs. | FINDINGS |
| 2 | fresh general-purpose | Async onSubmit rejection escaped the synchronous catch. Parent reproduced an unhandled-rejection event in real Chromium despite success; repaired notification boundary to handle returned Promises. Unit assertions alone did not expose the rejection, so permanent browser coverage was added. | SDK 22 tests, typecheck, Biome, and rebuilt dual-entrypoint Chromium including async-notification rejection passed. | FINDINGS |
| 3 | fresh general-purpose | Moving private region escaped its earlier geometry mask. Independently reproduced against the old emitted bundle with a failing pixel regression. Exclude private elements (including their original references) from the renderer in addition to bitmap masks; omit capture if the document root is private. Fixed filter's text-node handling after browser capture exposed the renderer contract. | SDK 22, workspace typechecks, Biome and final Chromium ESM/IIFE passed, including moving-private pixel regression. | FINDINGS |
| 4 | fresh general-purpose | Configured positive lower request/metadata caps were silently raised to 16 KiB/128 bytes. Independently reproduced both in failing unit regressions; changed clamping minimum to 1 byte. | SDK 24, typecheck, Biome, rebuilt ESM/IIFE Chromium passed. | FINDINGS |
| 5 | fresh general-purpose | No additional actionable findings in current widget/docs scope. | Reviewer independently passed SDK 24, typecheck, rebuilt dual-entrypoint Chromium; parent also passed final integrated local e2e. | NO_ACTIONABLE_FINDINGS |

Five-round productivity checkpoint: productive and converged. Four rounds closed distinct reproduced defects with bounded repairs and regression coverage; scope remained the authorized widget flow and its preserved privacy/lifecycle/options contracts. Round 5 found no recurrence or additional actionable defect.

## Deployment

- Wrangler 4.59.2 with stored OAuth, no API-token environment override; pinned account `a66bc72c08cbf1ad8f469100572015b7`.
- Deployed `workers-sentinel` at `wat.tilmonengineering.com`, version `0fcee12b-00fc-4213-aff0-e941cc11ee44` (previous `f3443ec9-9ac4-488c-817f-f268061a00f0`). Deployment list confirmed 100% current version.
- `/api/health` returned 200. Live `/sdk/feedback.js` and `/sdk/SKILL.md` exactly matched the local build and guide.
- Production Chromium verified one launcher, immediate selection without dialog, Escape cancellation, automatic screenshot and locator, two successive mocked-success/reset flows, and reopening. Feedback POSTs were intercepted in the browser; no test feedback reached production.
- Stable embed remains `https://wat.tilmonengineering.com/sdk/feedback.js`.
- The shared Playwright MCP Chrome launch failed with SIGTRAP; local package-managed Chromium succeeded for reproduction and live verification.

Capture remains best-effort DOM rendering, not native tab capture. Rendering-failure fallback is covered by unit tests; arbitrary customer DOM/CSP fidelity is not guaranteed. No npm publication or Git commit/push is part of this update.
