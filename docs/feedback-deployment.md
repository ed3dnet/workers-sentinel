# Feedback SDK deployment — 2026-10-07

Operator authorized deployment to `wat.tilmonengineering.com` and requested the hosted SDK embed URL.

- Worker: `workers-sentinel`
- Cloudflare account: `a66bc72c08cbf1ad8f469100572015b7`
- CLI: Wrangler 4.59.2, stored OAuth; no environment API token override.
- Deployed version: `3b992e04-90c3-40e8-bbe3-84672d197b8f`, 100% traffic.
- Previous version / rollback reference: `fa032a2a-34a2-402e-bcf4-72b9d102fa8e`.
- Bindings preserved: AuthState, ProjectState, `sentinel-attachments` R2, dashboard ASSETS; migration history unchanged.

## Embed URLs

- Stable: https://wat.tilmonengineering.com/sdk/feedback.js
- Version-pinned: https://wat.tilmonengineering.com/sdk/v0.1.0/feedback.js

Dashboard build now invokes `scripts/build-feedback-assets.mjs` to build the SDK and include both static copies. Independent evidence review returned `NO_ACTIONABLE_FINDINGS`; an earlier review was blocked only by missing command execution, not counted as approval.

## Checks

Before deployment: identity/account discovery, existing deployment and R2 bucket inspection, dashboard+SDK build, Wrangler deploy dry-run, Biome target files and whitespace check. All three SDK copies were identical (56,822 bytes, SHA-256 `52703e141ef96c45edddddc002b213fa3672d72a0e958880f57932b07b7102d3`).

After deployment: `/api/health`, `/`, and both SDK paths returned 200. Scripts served `text/javascript`, matched the local SHA-256, and Chromium loaded the live versioned script and confirmed `typeof window.WorkersSentinelFeedback.install === 'function'`. Wrangler deployment listing confirmed 100% traffic on the deployed version.

No production feedback records or test users were created. No npm publication or secret changes were performed. `wrangler whoami --json` was unsupported by this installed CLI; normal `whoami` supplied identity/account evidence instead.
