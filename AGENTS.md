# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` points here for Claude Code compatibility.

## Project Overview

Workers Sentinel is a self-hosted, Sentry-compatible error tracking system running entirely on Cloudflare Workers. It accepts events from Sentry SDKs via the envelope protocol and stores them in SQLite-backed Durable Objects.

## Commands

```bash
# Development - runs worker with wrangler dev
pnpm dev

# Build dashboard then worker
pnpm build

# Deploy to Cloudflare
pnpm deploy

# Lint with Biome
pnpm lint
pnpm lint:fix

# Format
pnpm format

# Typecheck all packages
pnpm typecheck

# Dashboard-specific
pnpm --filter @workers-sentinel/dashboard dev      # Vite dev server
pnpm --filter @workers-sentinel/dashboard build    # Production build

# Worker-specific
pnpm --filter @workers-sentinel/worker dev         # Wrangler dev
pnpm --filter @workers-sentinel/worker test        # Run tests once
pnpm --filter @workers-sentinel/worker test:watch  # Run tests in watch mode
pnpm --filter @workers-sentinel/worker typecheck   # TypeScript check
```

## Architecture

### Monorepo Structure

- `packages/workers-sentinel/` - Cloudflare Worker (Hono framework)
- `packages/dashboard/` - Vue.js 3 frontend (served as static assets)

### Durable Objects

Two SQLite-backed Durable Objects handle all state:

**AuthState** (singleton, named "global"):
- `users`, `sessions`, `projects`, `project_members` tables
- Handles registration, login, session validation, project registry
- All requests go through `http://internal/*` fetch pattern

**ProjectState** (per-project, named by project ID):
- `issues`, `events`, `issue_stats`, `issue_users` tables; `attachments` holds only ~200-byte metadata rows (payloads live in R2 under `p/{projectId}/…` keys)
- Handles event ingestion, issue grouping, statistics
- Each project has isolated storage

### Request Flow

```
Sentry SDK → /api/{projectId}/envelope/ → DSN validation (AuthState)
           → Parse envelope → Fingerprint → Store (ProjectState)

Dashboard  → /api/auth/* (public) → AuthState
           → /api/projects/* (protected) → authMiddleware → ProjectState
```

### Key Modules

- `lib/envelope-framer.ts` - Incremental Sentry envelope framing state machine: feed decompressed chunks, get envelope/item header and payload-chunk events. One framing implementation shared by the streaming ingest route and the `parseEnvelope` collector.
- `lib/envelope-parser.ts` - `parseEnvelope` (collector over the framer), DSN/auth-header parsing, event sanitization
- `lib/attachment-store.ts` - R2 storage contract: key layout (`p/{projectId}/u/{nonce}/{index}` uploads, `p/{projectId}/m/{attachmentId}` migrated rows), all ingestion caps, the per-request store factory, and the test-only fault-injection vocabulary
- `lib/fingerprint.ts` - Groups events into issues using exception type + message + stack frames
- `routes/ingestion.ts` - SDK endpoint, supports `?sentry_key=` and `X-Sentry-Auth` header; streams the request body end-to-end (never buffers whole envelopes), uploads attachment payloads to R2 as they arrive, decides envelope attachment cardinality in the worker, and forwards event + attachment metadata atomically to ProjectState
- `routes/attachments.ts` - Fetch-side attachment list + download endpoints (session/API-token auth; downloads stream from R2 with `Range` support)

### DSN Format

```
https://{publicKey}@{host}/{projectId}
```

The publicKey is validated against AuthState's projects table. ProjectState is accessed by project ID.

### Service Bindings

Cloudflare Workers can send events via service binding instead of HTTP for lower latency. The ingestion endpoint works identically - service bindings only change transport, not authentication. See README for custom transport setup.

## Native API reference (fetch-side)

The contract for API consumers (dashboard, CLI tooling, agent skills). The management/fetch API is **native JSON** — only ingestion speaks the Sentry protocol, with one exception: the read-only Sentry `/api/0` event-attachment compatibility surface documented in its own section below.

### Authentication

| Credential | Where it works | Notes |
|---|---|---|
| Session token (`Authorization: Bearer <token>`) | `/api/projects/*`, `/api/auth/*`, `/api/admin/*` | From `POST /api/auth/login`; what the dashboard uses |
| API token (`Authorization: Bearer wst_…`) | Same protected surface as sessions | Mint via `POST /api/auth/tokens` (session auth required); stored hashed; revocable |
| DSN public key (`?sentry_key=`, `X-Sentry-Auth`, or basic auth) | **Ingestion only** (`POST /api/{projectId}/envelope|store`) | Cannot read anything; never valid on `/api/projects/*` |

401 vs 404 precedence: auth middleware runs before route matching on protected namespaces, so an **anonymous** request to an unknown `/api/projects/…` path gets `401`, and an **authenticated** one gets a JSON `404`. Unknown `/api/*` paths (any method) return `404 {"error":"not_found"}` JSON — never the SPA HTML. One exception: `OPTIONS /api/*` is answered by the CORS preflight handler with a bare `204` before auth or 404 logic runs.

### Pagination

List endpoints that paginate use keyset pagination:

- `?limit=` — page size, clamped to 1..100. Values below 1 (or non-numeric) fall back to the endpoint default rather than clamping to 1. Default 25 (issue activity: 50).
- `?cursor=` — pass the previous page's `nextCursor` verbatim.
- Response shape: `{ <rows>, nextCursor?, hasMore }`. `nextCursor` is the sort key of the last row on the page and is **omitted** when there are no more rows (do not treat an absent cursor as "repeat the last page"). The cursor is per endpoint and follows that endpoint's sort: issues pages by the active `sort` field (`last_seen` by default), issue events by `timestamp` DESC, issue activity by a composite `createdAt|id` key — a cursor from one sort order is not valid for another.

### Endpoints (read side)

- `GET /api/health` — public liveness probe.
- `GET /api/projects` — projects the caller can access.
- `GET /api/projects/:slug/issues` — filters: `status`, `level`, `environment`, `query`, `tags=k:v` (≤5), `sort`; paginated.
- `GET /api/projects/:slug/issues/:issueId` — issue detail + recent stats.
- `GET /api/projects/:slug/issues/:issueId/events` — paginated (timestamp DESC).
- `GET /api/projects/:slug/events/latest?limit=` — most recent events across the project.
- `GET /api/projects/:slug/events/:eventId` — full stored event JSON.
- `GET /api/projects/:slug/events/:eventId/attachments` — attachment metadata for one event (no payload): `{ issueId, attachments: [{ id, eventId, filename, contentType, size, createdAt }] }`.
- `GET /api/projects/:slug/attachments/:attachmentId` — download: raw attachment bytes with the stored `Content-Type` and a sanitized `Content-Disposition: attachment` header (ASCII-safe quoted `filename` plus RFC 5987 `filename*` for non-ASCII names). Binary payloads stream from R2; single-range `Range` requests return `206` with `Content-Range`, unsatisfiable ranges return `416`, and metadata whose blob is missing returns `404 {"error":"attachment_data_missing"}`.
- Also available: `/:slug/summary`, `/:slug/stats`, `/:slug/tags`, `/:slug/tags/:key/values`, `/:slug/environments`, `/:slug/releases[/:version]`, `/:slug/issues/:issueId/comments|activity`, `/:slug/members`, `/:slug/settings`, `/:slug/rate-limit`, `/:slug/filters`, `/:slug/sourcemaps`.

### Attachments (ingested)

Envelopes may carry `attachment` items — **binary is supported**. Attachment payloads live in R2 (the `ATTACHMENTS` bucket binding, key layout `p/{projectId}/u/{nonce}/{index}` for fresh uploads and `p/{projectId}/m/{attachmentId}` for rows migrated from legacy inline storage); ProjectState keeps only ~200-byte metadata rows. Attachment items **SHOULD declare `length`**: length-less payloads are newline-delimited by protocol, so binary without `length` truncates at the first newline (deterministic 400/misparse) and is capped at 1 MiB.

Per envelope: ≤10 attachments, total attachment payload ≤21 MiB measured on the **bytes as received/stored** (exact: 22,020,096). A client that zstd-compresses individual payloads is bounded on the compressed bytes it sends — the server stores and serves those bytes **verbatim** (no server-side zstd decode; consumers detect compression via the stored content type, e.g. `application/zstd`). Filename ≤200 chars, content type ≤100 chars. Ingestion responses include `droppedAttachments: [{ filename, reason }]`; an empty array means everything landed. Full drop-reason vocabulary:

| Reason | Meaning |
|---|---|
| `too_large` | attachment payload would exceed the 21 MiB per-envelope budget (as received) |
| `too_many` | >10 attachments in one envelope |
| `no_unique_event` | envelope had zero or multiple events — no unambiguous owner |
| `event_filtered` | the associated event was dropped by an inbound filter |
| `project_attachment_quota` | per-project attachment bytes (10 GiB default) would be exceeded |

Request-body limits: wire (pre-decompression) body ≤27 MiB — sized so a fully budget-compliant envelope sent **uncompressed** (21 MiB attachments + 5 MiB of event/transaction payloads + framing) is never wire-rejected; decompressed body ≤64 MiB hard ceiling counting every byte (kept payloads, drained/oversized discarded attachments, and separator junk alike); envelope-header and item-header lines each ≤64 KiB. Over-wire/over-decompressed → `413`; framing/UTF-8/JSON violations → `400`; gzip stream errors mid-body → `400`.

If the R2 bucket itself fails during an attachment upload, the whole envelope fails with `503 {"error":"attachment_storage_failed"}` + `Retry-After: 5` — no event and no metadata are stored, and blobs already uploaded for earlier items are reclaimed by GC. **Retry behavior is client/transport-dependent**: the official sentry-javascript transports make one attempt and log non-2xx responses without auto-resending, so attachment-bearing events sent during an R2 outage may be dropped client-side unless the client's transport retries.

The byte budget (default 10 GiB, tunable per project by owners/admins via `PATCH /api/projects/:slug` with `maxAttachmentBytes`; a very large value ≈ unlimited) bounds **R2 usage**, not the Durable Object — there is no row cap. An over-budget project still accepts events, dropping only the new attachments, and never auto-deletes existing data; deleting events/issues reclaims the budget. A persisted usage counter (seeded idempotently, recomputed from `SUM(size)` at most daily by the DO alarm) enforces it.

Attachment lifecycle follows its event via cascade: retention pruning, issue deletion (single/bulk), and project purge remove blobs along with metadata rows; merges keep attachments downloadable under the surviving issue. There is no cross-service transaction between DO SQLite and R2: blobs upload before metadata commits, so a brief window exists where a listed attachment 404s its blob, and orphaned blobs (uploaded but never committed — e.g. duplicate resends, filtered events, aborted envelopes) are reclaimed by an hourly GC sweep after a 1-hour grace. The reclaim window scales with live object count (~10k objects scanned per hour: roughly 4 hours at ~40k live objects, 1–2 days near the 10 GiB budget with ~100 KiB blobs).

### Event IDs

Client `event_id`s round-trip: 32-hex values are lowercased, dashed 36-char UUIDs (any hex case) are normalized to 32-hex (dashes stripped, lowercased). Anything else is replaced by a server-minted id. An event payload without an `event_id` falls back to the envelope header's `event_id` (if present) before a server id is minted. Duplicate detection keys on the normalized id, so resending the same event (dashed or stripped) is an idempotent no-op (`duplicate: true`, no attachment duplication).

### Permalinks

Dashboard permalinks are `/projects/{projectSlug}/issues/{issueId}` (e.g. `https://host/projects/my-project/issues/12345678-…`). The API path space for the same resource is `/api/projects/:slug/issues/:issueId`.

## Sentry `/api/0` compatibility (event attachments)

A read-only mirror of Sentry's event-attachment API surface, additive to the native API above (which is byte-for-byte unchanged). Auth is the same Bearer credential space as `/api/projects/*` — session tokens and `wst_` API tokens both work; DSN public keys do not (they remain ingestion-only). The org path segment is accepted but ignored.

Routes (trailing slash optional on all of them):

- `GET /api/0/projects/{org}/{project}/events/{event_id}/attachments/` — list. `{project}` resolves by slug first, then by project id (both membership-gated).
- `GET /api/0/projects/{org}/{project}/events/{event_id}/attachments/{attachment_id}/` — metadata: the same nine-field object as the list elements.
- The detail route with `?download` (any value, including empty) — raw payload bytes: stored `Content-Type`, hardened `Content-Disposition: attachment; filename="…"` (plus RFC 5987 `filename*` for non-ASCII), and `Content-Length` equal to `size` (R2 bodies are piped through `FixedLengthStream` so the runtime emits the exact length). R2 payloads stream directly — no presigned-URL redirects. Inline legacy rows serve from DO storage until the alarm migrates them.

Serializer fields per attachment (exactly these nine): `id`, `event_id`, `type` (`"event.attachment"`), `name`, `mimetype`, `dateCreated` (ISO), `size`, `headers` (`{"Content-Type": mimetype}`), `sha1` (`null` — current Sentry serializer behavior).

**Pagination** follows Sentry's `Link` header convention (not the native `nextCursor` keyset): every page carries `rel="next"` and `rel="previous"` entries, each with `results="true|false"` telling the client whether following it would yield rows. The cursor format is `{id}:{offset}:{isPrev}`; only the offset segment is honored, and malformed cursors read as offset 0. `?limit=` clamps valid integers into 1..100 (default 100; non-integer or absent values fall back to the default). Ordering is by `name`.

**Errors** are Sentry-shaped on this namespace only: non-2xx responses use `{"detail": "…"}` (a namespace-local translator rewrites the native `{error[, message]}` shape, including authMiddleware's 401 bodies). Unknown event, unknown attachment, an attachment scoped under a different event, and non-member/cross-project access (by slug or id) all return `404 {"detail":"not found"}` — indistinguishable by design. Metadata whose R2 blob was deleted still returns 200, while its `?download` returns `404 {"detail":"attachment data missing"}`. Auth precedence matches the native API: anonymous probes of unknown `/api/0/…` paths get 401 (detail-shaped), authenticated ones the 404; `OPTIONS /api/0/*` still answers the global bare 204 preflight before auth.

**Documented deviations from Sentry** (single-tenant constraints):

| Sentry | Here |
|---|---|
| Real organization required in the path | Any non-empty `{organization_id_or_slug}` segment accepted (single tenant) |
| Numeric attachment ids | Opaque `{eventId}:{n}` composites — pass list values back verbatim |
| Token scopes (`project:read`, …) gate access | Not modeled; any valid session/API token with project membership passes |
| `sha1` content checksum | Always `null` |
| Downloads may redirect to presigned storage URLs | Direct stream, never a redirect |

## Git hooks (lefthook)

Lefthook is mise-pinned (`lefthook = "2.1.14"`) and activated by `just install` (`lefthook install`). Configuration lives in `lefthook.yml`:

- **pre-commit** (all commits): biome on staged js/ts/vue/json files; the full worker unit suite (vitest-pool-workers) whenever `packages/workers-sentinel/{src,test}/**`, `wrangler.jsonc`, `vitest.config.ts` or `pnpm-lock.yaml` are staged.
- **pre-push**: black-box integration suite (`just test-integration`) — only when the push updates `refs/heads/main` (detected from git's ref lines via lefthook's `use_stdin`; deletions never trigger it).

The integration runner (`scripts/integration.mjs`) stands up its **own** wrangler dev instance — its own port, its own `--persist-to` under a temp dir, `SETUP_TOKEN` injected via `--var` (process env does not become Worker bindings under `wrangler dev`) — waits for `/api/health`, runs `node --test packages/workers-sentinel/integration/`, and tears the whole process group down. It never touches the guarded supervisor's port or `_devenv/` state. Tests in `packages/workers-sentinel/integration/` are plain `node:test` files driven by `SENTINEL_INTEGRATION_URL`/`SENTINEL_SETUP_TOKEN`; they assume a pristine install (first-user bootstrap, global settings) and must not be pointed at a shared stack.

## Security posture (post-remediation, 2026-09)

Full remediation of the findings in `security-analysis/reports/` (see INDEX.md). Key properties now enforced:

- **Passwords**: argon2id (OWASP m=19MiB/t=2/p=1) via `@noble/hashes` pure JS — workerd disallows dynamic WASM compilation, so hash-wasm-style libraries fail at runtime. Legacy unsalted SHA-256 hashes upgrade transparently on successful login. Verification is constant-time; unknown accounts burn a dummy argon2 to equalize timing.
- **Sessions/API tokens**: stored hashed at rest (fast SHA-256 lookup hash — sufficient for 256-bit random tokens); max 20 sessions/user (oldest pruned); `POST /api/auth/logout-all` revokes everything; password change (`/api/auth/change-password`, requires current password) revokes all sessions.
- **Auth throttling**: 5 failed logins per email → 15min lockout (429 + retryAfter); registration limited 5/hour per `CF-Connecting-IP`; admin can close registration via `PUT /api/admin/settings {registrationOpen:false}`; first registration on a fresh install requires the `SETUP_TOKEN` env secret when set (fixes first-user-admin squatting).
- **Accounts**: admin can disable/enable users (`PATCH /api/admin/users/:id`) — disables kill sessions and return uniform login errors (no disable oracle).
- **CORS**: same-origin by default; cross-origin dashboard API access only for origins in the `CORS_ORIGINS` env (comma-separated). Only SDK ingestion endpoints (`/:projectId/envelope|store|security`) serve wildcard CORS — without credentials.
- **Headers/CSP**: hardening headers on all worker responses + strict CSP and friends via `packages/dashboard/public/_headers` for asset-served pages (the assets layer bypasses the worker for non-`run_worker_first` paths).
- **Ingestion**: streaming body parse with 27MiB wire / 64MiB decompressed caps (gzip bombs rejected), ≤20 envelope items, ≤64KiB header lines, strict malformed-item handling; attachment payloads stream to R2 under per-request nonce keys (21MiB/envelope budget, 10 GiB/project default) with storage failures surfaced as 503 and orphaned blobs reclaimed by an hourly GC sweep; `sanitizeEvent` validates/replaces client-controlled `event_id`/`timestamp`/`level`, truncates fields, caps tag/frame/breadcrumb cardinality (applied inside ProjectState so RPC ingestion is covered); duplicate `event_id` is an idempotent no-op, not a 500.
- **Redaction**: `authorization`/`cookie`/`set-cookie`/`x-api-key`/etc. request headers, cookies, env dicts and secret-ish query params are scrubbed before storage; per-project `scrubHeaders` via `PATCH /api/projects/:slug` (owner/admin); `GET /api/{projectId}/security` reflects the real config.
- **Tenancy**: project security config (retentionDays, maxEventsPerHour, scrubHeaders, webhookUrl) and inbound filters require owner/admin; project deletion purges the ProjectState DO entirely (R2 blobs swept first — the purge retries on the DO alarm if the sweep cannot finish, and ingests are rejected with 503 while it is pending); `get-project` has no unscoped branch.
- **Attachment storage**: blobs live in the project's own R2 key prefix (`p/{projectId}/…`); upload keys embed a per-request random nonce (unguessable but not treated as secret); downloads remain membership-gated through the worker, which checks project access before any bucket read.
- **Storage/DoS**: all list endpoints clamp `limit` (1..100; negative fell through to SQLite `LIMIT -1` = unlimited); sourcemap uploads capped 5MiB/200-per-project; merge lists capped at 100; stats bucket by server receipt time (client timestamps can no longer outlive retention); fingerprints use SHA-256, not 32-bit djb2.
- **Webhooks**: https-only, no credentials-in-URL, private/loopback hosts rejected, redirects refused, 10s timeout, target response bodies never logged; webhook URLs hidden from plain members.
- **Route hygiene**: `/api/projects/:slug/events/latest` registered before `/:eventId` (was shadowed); auth header parsing case-insensitive and trim-tolerant; attacker-controlled content is not logged.

Env vars: `SETUP_TOKEN` (first-registration gate), `CORS_ORIGINS` (dashboard API allowlist). Set both as wrangler secrets/vars in production.

Known accepted limitations: the DO `http://internal/*` surface remains a zero-auth trust boundary (reachable only via service bindings, mitigated by uniform route-level checks); session tokens still live in localStorage (XSS-verified-negative + CSP backstop); no email infrastructure, so no self-service password reset (admin disable + re-register is the workflow).

Tests: 297 across 34 files (`just test`) + 11 black-box integration tests (`just test-integration`; R2 and the fault-injection switch are simulated by miniflare from `wrangler.jsonc`/`vitest.config.ts` — the fault vocabulary is inert without the test-only `ATTACHMENT_FAULT_INJECTION` binding). Argon2 costs ~250ms CPU per hash — tests that repeatedly register/login carry raised timeouts; keep an eye on Workers CPU limits if you raise parameters.

## Polytoken harness sessions

Long-lived processes run as **shell services**, not background shell jobs (background jobs are reaped between turns). The local stack is a single foreground supervisor, so one service holds it:

- **Start**: `shell_service` with name `sentinel-dev` (if that name is already terminal from a prior run, start the replacement under a new name such as `sentinel-dev2` — `restart` on an already-exited service errors), command `exec just dev-up`, health check `curl -sf http://127.0.0.1:25304/api/health >/dev/null` (5s interval), `copy_url: http://127.0.0.1:25304`, and `notification_match: 'Ready:'` so readiness wakes the session.
- **Readiness**: wait for the `ServiceHealthCheckPassed` notification or the supervisor's `Ready:` log line. The first start builds the dashboard (up to ~2 min budget); later starts are warm and ready in seconds. Read logs with `job_status` on the service's job id.
- **Stop**: run `just dev-down` via `shell_exec` from any shell — it performs the authenticated loopback stop and cleans the ownership records (`inventory.json`, `lock/`, `control.json`). Never kill a recorded PID. A SIGTERM delivered to the supervisor process itself also triggers its clean stop handler.
- **Stale state**: if `dev-up` refuses because `inventory.json` or `lock/` remain after an unclean end, reconcile manually (confirm nothing listens on the port, then delete those records) before starting a new service — do not script around the guard.
- **One-off commands** (`just smoke`, `just send-demo-events`, `just test`, `just lint`) are plain `shell_exec` calls; they talk to the running service over loopback and don't need Polytoken management of their own.

## Local development stack (guarded supervisor)

A scaled-down port of the ed3dsite-2025 `_devenv/cloudflare` pattern lives in `_devenv/cloudflare/`. It runs the whole stack locally under Workerd (`wrangler dev`) with no Cloudflare credentials: child processes are spawned with `CLOUDFLARE_*`/`CF_*`/`WRANGLER_*`/`DOCKER_*` variables stripped, so the supervisor is local-only by construction. Remote deployment is deliberately not a command here (pinned for later; it would use wrangler's own interactive login, never shared secrets machinery).

```bash
just install            # pnpm install across the workspace
just dev-up             # foreground supervisor: builds dashboard via wrangler's build.command, waits for /api/health
just dev-down           # authenticated stop via loopback control endpoint (from another terminal)
just dev-reset --confirm-local-reset  # remove repo-owned local state (refuses while an inventory record exists)
just smoke              # GET /api/health + / against a running supervisor
just send-demo-events   # seed demo user/project/events (Sentry envelopes) against a running supervisor
just test               # worker test suite (vitest-pool-workers; no supervisor needed)
```

- State lives in `_devenv/cloudflare/.state/dev/` (gitignored): `persist/` (Durable Object SQLite state, survives restarts), plus ephemeral `inventory.json`, `lock/`, `control.json` ownership records that are removed only on clean stop.
- Port is deterministic per checkout path (this checkout: 25304); override with `SENTINEL_LOCAL_PORT`. Binding is `127.0.0.1` only.
- `dev-down` never signals recorded PIDs. If `dev-up` refuses due to a stale inventory/lock (e.g. after a crash), reconcile manually: confirm nothing listens on the port, then delete `inventory.json` and `lock/` yourself — never `kill` a recorded PID.
- Demo credentials: `demo@sentinel.local` / `sentinel-demo-password` (project `CLI Feedback`).

## Wrangler R2 CLI trap: `r2 object` defaults to LOCAL storage

`wrangler r2 object put/get/delete` operate on the **local miniflare store** (`.wrangler/state/v3/r2/…`) when run from a directory whose wrangler config declares an `r2_buckets` binding — `packages/workers-sentinel/` does (`ATTACHMENTS`). To touch the production `sentinel-attachments` bucket you must pass **`--remote`**:

```bash
# Production bucket (what the worker's binding actually reads/writes):
npx wrangler r2 object get sentinel-attachments/p/<projectId>/... --remote --pipe

# Without --remote you silently read/write a throwaway local copy —
# symptoms: your own CLI-written keys round-trip fine while every
# production key "does not exist", even though
# `wrangler r2 bucket info sentinel-attachments` (control plane, no local
# mode) shows the real object count/size. This wastes hours if mistaken
# for a consistency or auth problem. (Also: `r2 object delete` takes no
# `--force` flag — passing one just prints usage.)
```

## Technology Stack

- **Worker**: Hono, Cloudflare Workers, Durable Objects with SQLite
- **Dashboard**: Vue 3, Pinia, Vue Router, Tailwind CSS, Vite
- **Tooling**: pnpm workspaces, Biome (lint/format), TypeScript

## Testing

Tests use `@cloudflare/vitest-pool-workers` with `isolatedStorage: false` and `singleWorker: true` for state persistence across tests within a describe block. DO operations may fail with "invalidating this Durable Object" error during test restarts—test utilities include retry logic for this.

## Code Style

Biome enforces: tabs for indentation, single quotes, semicolons required, 100 character line width.
