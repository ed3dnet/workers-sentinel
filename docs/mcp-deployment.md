# Project MCP deployment — 2026-10-07

Operator authorized deployment and repository-local Polytoken setup for `sentinel-itself` after implementation review converged.

## Deployment

- Worker: `workers-sentinel`; custom domain `https://wat.tilmonengineering.com`.
- Account explicitly pinned: `a66bc72c08cbf1ad8f469100572015b7`.
- Wrangler4.136.1 (repository dependency); stored OAuth identity `sean@tilmonengineering.com`; no environment API-token override.
- Previous deployed version: `0fcee12b-00fc-4213-aff0-e941cc11ee44`.
- New deployed version: `4f309619-74fc-4ca1-a37d-5add107ed02a`.
- Deployment ID: `e8429b14-3130-4a0c-8c9f-f438035c2a33`,100% traffic, independently verified through deployment listing.
- Command: `CLOUDFLARE_ACCOUNT_ID=a66bc72c08cbf1ad8f469100572015b7 pnpm --filter workers-sentinel exec wrangler deploy`.

## Live verification

Existing git-ignored local API credentials were used without displaying their values. Project lookup confirmed `sentinel-itself` / `Sentinel Itself` / `653a8a0a-a93b-4901-887b-3a751218fe6a`.

HTTP checks passed:

- `/api/health`, `/sdk/feedback.js`, `/sdk/v0.1.0/feedback.js`, `/sdk/SKILL.md`:200 with appropriate JSON/script/Markdown content types.
- Project MCP initialization:200, negotiated protocol2025-11-25; initialized notification202.
- `tools/list`:11 documented tools.
- Read-only `list_issues` and `list_feedback`:200; feedback includes unresolved status and omits internal screenshot keys.
- Anonymous MCP:401; authenticated GET:405; disallowed supplied Origin:403.

No production test accounts, projects, feedback, comments, or status/snooze mutations were created. Playwright MCP browser startup failed (Chrome exited with SIGTRAP), so no live browser UI validation is claimed. CLI discovery commands for `wrangler auth list` and `polytoken mcp` were unsupported; identity/deployment checks used supported commands instead.

## Repository Polytoken setup

Created `.polytoken/config.yaml` with HTTP server `sentinel` targeting `https://wat.tilmonengineering.com/api/projects/sentinel-itself/mcp`, enabled by default,30-second tool timeout, and bearer `${SENTINEL_API_TOKEN}` env reference only. `mise.toml` loads the existing git-ignored `.env`; its secret values were not copied into any tracked file. Mise2026.7.16 and Polytoken0.8.19 were observed.

Start from this checkout with `mise exec -- polytoken`. In the current workstation environment where `/tmp` user quota is full, use:

```sh
TMPDIR=/var/tmp/workers-sentinel-vitest mise exec -- polytoken
```

Existing sessions do not automatically inherit a newly loaded environment. `/daemon-reload` can re-read configuration when the daemon already has `SENTINEL_API_TOKEN`; otherwise start a new session through mise. No existing daemon environment was changed in this work.

Verification: `.env` is git-ignored; mise reports token presence without values; `mise exec -- polytoken config validate --project` passed; `TMPDIR=/var/tmp/workers-sentinel-vitest mise exec -- polytoken doctor --format json` reported `sentinel` connected with11tools,0failures. An unrelated Playwright connection timed out. The first doctor run failed creating a temp session directory due to `/tmp` quota; the alternate directory resolved it.

Configuration review Round1 (`general-purpose-mini:sentinel-config-review`) inspected endpoint, environment reference, git-ignore and mise declarations; no configuration or credential-handling defect was identified. Its FINDINGS verdict concerned the stale pending-review line in this document, now replaced with this ledger. Runtime connection validation is recorded above. Fresh Round2 (`general-purpose-mini:sentinel-config-review-r2`) inspected the revised scoped files and returned **NO_ACTIONABLE_FINDINGS**; setup review converged. No credential values belong in this document or committed configuration.
