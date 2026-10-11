# Feedback / Issues page parity

Operator request: independently inventory the Issues and Feedback page differences, then correct Feedback so filters/page count, copy/icons and Quick Setup match Issues with the entity swapped.

## Inventory

Read-only `general-purpose:page-parity-inventory` compared the views and feedback SDK contract. Concrete differences confirmed by parent:

- Feedback introduced a separate heading/description and top-of-page setup details; Issues starts with compact filters and places Quick Setup under its centered empty state.
- Feedback status/page-size controls used visible wrapper labels and numeric-only options; Issues uses `input w-auto`, `All Issues`, and `25 / page`, `50 / page`, `100 / page`.
- Feedback lacked the Issues loading spinner and check-circle empty SVG, used a boxed empty message, and different headings/body copy.
- Feedback setup heading, background, typography, code blocks and explanatory copy differed.
- List hover/spacing/type and quick action placement differed; paging said `Load more feedback` rather than `Load More`.

## Implementation/review boundaries

Feedback should match the Issues visual component styles, setup heading, icon, loading and empty-state copy with feedback substituted. Its installation must still use the actual feedback SDK hosted path and `window.WorkersSentinelFeedback.install` with the real project DSN; copying Sentry ingestion setup would be nonfunctional. Keep truthful filtered-empty messages, bounded search, unresolved/resolved statuses,25/50/100 paging and stale-response guards. Setup remains accessible with existing reports (previous approved behavior). No invented issue-only severity/environment/tags/ignored/snooze/merge/destructive workflow, credential exposure, unverified npm claim or production data mutations.

Review dimensions: visual/copy parity, executable setup, usability/accessibility, filters/paging/actions/races and existing regression preservation. Fresh read-only reviewer must return explicit NO_ACTIONABLE_FINDINGS or documented findings/blocked status; repair and re-review any actionable in-scope findings.

| Round | Reviewer | Findings | Repair | Validation | Verdict |
|---|---|---|---|---|---|
| 1 | `general-purpose:page-parity-review-r1` | F-1 relative-time mismatch; F-2 setup stays collapsed on populated→empty project navigation | Copied Issues relative labels while retaining datetime; reset initial setup state on slug changes, preserving collapse after initial result |35dashboard tests, typecheck, build and formatting/whitespace passed; regressions for both conditions | FINDINGS, repaired |
| 2 | `general-purpose:page-parity-review-r2` | F-3 Quick Setup inaccessible when filtered results empty | Extracted one FeedbackQuickSetup component reused in unfiltered empty, filtered empty and populated states; kept truthful no-match copy and expansion decisions |35dashboard tests, typecheck, build, scopedBiome and whitespace passed; filtered-empty setup toggle regression | FINDINGS, repaired |
| 3 | `general-purpose:page-parity-review-r3` | No additional actionable findings within reviewed scope | None | Independent18feedback tests/typecheck; parent35full dashboard tests/build/scopedBiome/whitespace | NO_ACTIONABLE_FINDINGS |

Implementation completed in `Feedback.vue` and its component tests: Issues-style status/page-size dropdowns first, bounded accessible search, matching spinner/check-circle/icon copy, centered Quick Setup styling with actual hosted feedback SDK code, matching list row/action/date placement and Load More labels. Filters, keyset paging, status actions and stale-request guards preserved. Baseline:33dashboard tests/7files, typecheck, dashboard+SDKbuild, scopedBiome and whitespace checks passed. Review outcome CONVERGED after3fresh `general-purpose` rounds. All actionable findings repaired and regression-tested; latest exact verdict NO_ACTIONABLE_FINDINGS. Quick Setup is now a single component reused for all valid list states, relative time matches Issues, and initial setup expansion resets per project. Visual parity was checked through templates/classes/component tests, not pixel-level browser rendering. Operator-authorized deployment completed: version `0dc24530-55d1-4f6c-bd40-7f5b2de57d9e`, deployment `b82bc4f4-9c0c-4673-be76-7196e8569766`,100%traffic at `wat.tilmonengineering.com`, account `a66bc72c08cbf1ad8f469100572015b7`,Wrangler4.136.1 storedOAuth. Previous version `4f309619-74fc-4ca1-a37d-5add107ed02a` retained as rollback reference. Live HTTP health/dashboard/newFeedbackbundle/stable+versionedSDK and authenticated project MCP read checks passed. Served Feedback bundle contains Quick Setup/All Feedback/25 per page/No feedback yet/Load More copy. No production test records or status mutations created; no pixel-level browser check claimed.
