# A3 — Data Exposure & Outbound

Analyst A3 · Static security analysis · workers-sentinel

## Summary

**Scope** (assigned slices):

- `packages/workers-sentinel/src/durable-objects/project-state.ts` — all query/mutation paths: issues, events, search, tags, stats, releases, comments/activity, retention alarm, settings, sourcemaps, merge.
- `packages/workers-sentinel/src/routes/issues.ts`, `events.ts`, `releases.ts`, `sourcemaps.ts` — read/write APIs over stored data.
- `packages/workers-sentinel/src/index.ts`, `src/lib/webhook.ts`, `src/rpc.ts`, `src/types.ts`, `packages/workers-sentinel/wrangler.jsonc` — app wiring, outbound webhooks, RPC surface, deployment config.
- Cross-referenced (for authz evidence only): `src/middleware/auth.ts`, `src/durable-objects/auth-state.ts` (get-project / get-project-by-key / update-project / delete-project), `src/routes/projects.ts` (test-webhook, delete), `src/routes/ingestion.ts` (webhook trigger site), `test/*.test.ts`.

**Method**: full read of every slice file; line-level tracing of each read/write path from route → DO handler → SQL; test files reviewed as evidence of covered vs. uncovered behavior; one external fact verified against Cloudflare documentation (workerd/D1 enforce foreign-key constraints, equivalent to `PRAGMA foreign_keys = on` — sources: developers.cloudflare.com/d1/sql-api/foreign-keys/ and the D1 "SQL statements" page; community confirmation that this applies to Durable Object SQLite as well). No code was executed; the local dev stack on 127.0.0.1:25304 was not touched.

**Confidence**: high for structural findings (all claims traced to exact lines); medium for exploitability ratings that depend on deployment context (which origins are "internal" for webhook SSRF, observability retention settings, Cloudflare DO storage quotas). SQL-injection review is clean — all dynamic SQL is parameterized, `ORDER BY` uses a whitelist, `IN (...)` placeholders are generated.

**Finding counts**: 2 HIGH · 5 MEDIUM · 5 LOW (+ hardening notes).

---

## Findings

### 1. [HIGH] Raw event payloads — including `request.headers`, `request.env`, cookies, PII and any secrets the SDK captured — are stored verbatim and served unredacted to every project member

- **Where**: `src/durable-objects/project-state.ts:414-432` (ingest stores `JSON.stringify(event)` wholesale into `events.data`); served verbatim at `project-state.ts:849` (`handleGetIssueEvents`), `:873-876` (`handleGetEvent`), `:888-891` (`handleGetLatestEvents`); exposed via `src/routes/events.ts:42-137`. Shape permitting this: `src/types.ts:153-160` (`RequestContext.headers`, `.query_string`, `.data`, `.env`) and `:134-141` (`tags`, `extra`, `contexts`, `breadcrumbs`).
- **Description**: Sentry SDKs routinely capture HTTP request headers (`Authorization`, `Cookie`, `X-Api-Key`), environment variables (`request.env`), form bodies (`request.data`), user emails/IPs/usernames, and free-form `extra`/`contexts`. workers-sentinel persists the full event JSON with no scrubbing and serves it back with no redaction and no role distinction — the lowest project role (`member`) and any `wst_` API token of a member get everything. There is no equivalent of Sentry's server-side data scrubbers or PII stripping.
- **Production exploitation scenario**: an attacker obtains or holds a `member`-role account (or a member's `wst_` API token, which grants identical API access via `src/middleware/auth.ts:29-47`). They poll `GET /api/projects/:slug/events/latest` and `GET /api/projects/:slug/issues/:issueId/events` and harvest, for every recorded error: end-user emails and IPs (`event.user`), victims' session cookies and bearer tokens (`event.request.headers`), and server-side environment snapshots (`event.request.env`) from any instrumented service that forwards request context. This converts the error tracker into a credential store readable by the least-privileged project role.
- **Remediation**: (a) apply server-side scrubbing at ingest — strip/replace `request.headers` sensitive keys (Authorization, Cookie, Proxy-Authorization, X-Api-*, Set-Cookie), drop `request.env` and `request.data` unless explicitly allow-listed, and offer per-project redaction rules (regex on tags/extra/contexts); (b) gate full raw-event reads behind an elevated role (owner/admin) or an audit-logged "sensitive view" action; (c) treat breadcrumbs/`extra` as redact-by-default. Document that SDK-side `beforeSend` is the customer's control, not the server's.

### 2. [HIGH] Deleting a project leaves 100% of its data in the ProjectState Durable Object — no purge ever runs

- **Where**: `src/routes/projects.ts:347-389` (delete route only calls AuthState `/delete-project`); `src/durable-objects/auth-state.ts:514-541` (`handleDeleteProject` = single `DELETE FROM projects` + member cascade). Nothing anywhere calls into the `ProjectState` DO (`idFromName(project.id)`) to drop its tables or `storage.deleteAll()`.
- **Description**: The ProjectState DO named by the project UUID holds `issues`, `events` (raw payloads incl. PII, Finding 1), `event_tags`, `issue_users` (hashed identifiers), `issue_comments`, `issue_activity`, `source_maps` (full source code), `releases`, config and settings. Project deletion removes only the AuthState registry row. The DO database — and its billing footprint — persists indefinitely after the user believes the project is destroyed. The data becomes unreachable through the public API (slug no longer resolves), but remains on disk, addressable by any code with the project ID (including future admin tooling or a misconfigured route that trusts client-supplied project IDs).
- **Production exploitation scenario**: an operator receives a GDPR erasure request, deletes the project in the dashboard, and confirms the API returns 404. All personal data (emails, IPs, request headers) and all uploaded source maps remain in the DO's SQLite storage with no API or tooling to remove them — a silent retention violation, plus a standing quota/cost leak (one deleted-but-never-emptyed DO per deleted project, forever).
- **Remediation**: in the delete route, after AuthState deletion, fetch the ProjectState stub and invoke a new `/purge` internal endpoint that drops all tables (or `ctx.storage.deleteAll()`), and verify success before returning 200; if asynchronous, record a pending-purge marker and retry via alarm. Also add an operator-level "purge orphaned DOs" audit. Cover with an integration test that asserts storage is empty post-delete.

### 3. [MEDIUM] Pagination bounds defeated by negative `limit` — SQLite treats negative LIMIT as unlimited, enabling one-request full dumps

- **Where**: `src/durable-objects/project-state.ts:616,671` (`handleGetIssues`), `:834-845` (`handleGetIssueEvents`), `:882-886` (`handleGetLatestEvents` — binds `pageLimit` directly), `:988,1002` (`handleGetTagValues`), `:1020,1031` (`handleGetReleases`), `:1286,1299` (`handleGetActivity`). Client entry: `src/routes/events.ts:66,130`, `src/routes/issues.ts:130,438,467,606`, `src/routes/releases.ts:64` — all do bare `parseInt(limit, 10)` with no lower-bound check.
- **Description**: every list handler computes `Math.min(limit || 25, 100)` — which clamps only the *upper* bound. `?limit=-1` (or `-2`, where `pageLimit + 1 = -1` is what gets bound) produces `LIMIT -1`, which in SQLite means **no upper bound**. `handleGetLatestEvents` binds the negative value directly and applies no `.slice()`, so `GET /api/projects/:slug/events/latest?limit=-1` returns **every event row with its full raw JSON** in a single response. The other handlers return `rows.slice(0, -2)` — i.e., all but the last two rows. `handleGetTagValues` with a negative limit similarly returns the full value set.
- **Production exploitation scenario**: a member-authenticated script issues `GET /api/projects/:slug/events/latest?limit=-1` once and receives the project's entire event history (credentials/PII per Finding 1) in one shot — no pagination noise, trivially scriptable exfiltration; on a large project this is also a memory/CPU spike on the DO (single-tenant SQLite, one DO per project → ingestion for that project stalls while the dump serializes).
- **Remediation**: normalize once: `const pageLimit = Math.min(Math.max(Math.trunc(limit || 25), 1), 100)` in every handler (or a shared helper); reject non-integer/negative limits with 400 at the route layer. Add a test: `?limit=-1` must not return more than the default page size.

### 4. [MEDIUM] Outbound webhook: update-time HTTPS check is bypassable via redirects; no host/IP restrictions, no timeout, unbounded response read, and webhook target responses are logged/echoed

- **Where**: `src/lib/webhook.ts:48-64` (`sendWebhook`: plain `fetch`, default `redirect: "follow"`, `await response.text()` with no cap, no `AbortSignal.timeout`); validation only at config time in `src/durable-objects/auth-state.ts:576-584` (scheme must be `https:`; **no** host blocklist); trigger at `src/routes/ingestion.ts:173` (`waitUntil(sendWebhook(project.webhookUrl, payload))`); echo path `src/routes/projects.ts:284-345` (`test-webhook` returns the target's response `body` to the caller and runs `response.text()` unbounded).
- **Description**: the only control on where the server sends POSTs is "URL parsed as https at the moment an owner/admin saves it". `fetch` follows up to 20 redirects by default: a target answering `307/308` re-sends the POST body (301/302 degrade to GET) to any URL, including plain `http://`, internal hostnames, or another Cloudflare Worker that fronts an internal API — the scheme validation never re-applies per hop. There is no deny-list for loopback/link-local/RFC1918/metadata-style targets, no request timeout (a slow webhook pins `waitUntil` subrequest time), and failure bodies are read whole into memory and written to `console.error` (retained by Workers Logs, see Finding 8). The `test-webhook` route additionally reflects the target's response body to the requesting member and is callable by any project member, not just the owner/admin who configured the URL.
- **Production exploitation scenario**: (a) a project admin (or an attacker who compromised an admin session) points the webhook at `https://redirect.example` which 307-redirects to an internal service URL reachable from the worker (e.g., an internal-status endpoint or another worker in the org that is not meant to be publicly callable) — the sentinel server now faithfully POSTs to internal infrastructure on every new issue; (b) any *member* repeatedly hits `POST /api/projects/:slug/test-webhook` to make the server fire requests at the owner-configured target (amplification) and reads back the target's raw response body in the 502 JSON; (c) a webhook target returning a multi-gigabyte body forces unbounded `response.text()` into Worker memory (per-request 128 MB limit → OOM) — this from a mere member on `test-webhook`.
- **Remediation**: use `redirect: 'manual'` and re-validate scheme + host on every hop (or cap redirects to a validated allow-list); block loopback/link-local/RFC1918/undocumented-reserved ranges and known metadata endpoints at both save-time and delivery-time; add `signal: AbortSignal.timeout(10_000)`; cap response reads (e.g., stream with a byte limit) and never echo or log target response bodies — log status only; restrict `test-webhook` to owner/admin.

### 5. [MEDIUM] Webhook URL — which typically embeds the provider's auth token in the path — is readable by every project member

- **Where**: `src/durable-objects/auth-state.ts:406-425` (`handleListProjects` returns `webhook_url`), `:441-475` (`handleGetProject` — the endpoint backing `getProjectWithAccess`, used by *every* project-scoped route, returns `webhook_url` and `public_key` to any member).
- **Description**: setting the webhook is correctly restricted to owner/admin (`auth-state.ts:566-574`), but reading it is not: `GET /api/projects` and every `getProjectWithAccess` call expose the full URL. Webhook URLs for Slack/Discord/Generic-JSON providers carry capability tokens in the path (`https://hooks.slack.com/services/T…/B…/XXXX…`). Any `member`-role user (or their API token) can copy it and post arbitrary messages to (or rotate-check/exhaust) the owner's integration outside the system.
- **Production exploitation scenario**: a low-privilege member opens the projects list, copies the Slack webhook URL, and posts spoofed "new error" notifications to the company incident channel — or exfiltrates the token for later abuse after their access is revoked, since Slack webhook URLs are bearer capabilities.
- **Remediation**: mask `webhookUrl` in member-facing responses (host-only preview, or omit entirely) and reveal the full value only to owner/admin; the dashboard only needs write-access to the field, not read-back of the secret.

### 6. [MEDIUM] Source maps: unlimited uploads with no per-project quota (storage exhaustion), and any member can upload or download full production source code

- **Where**: `src/durable-objects/project-state.ts:1803-1919` (upload validates size ≤ 5 MB and JSON, but no count/aggregate quota; list capped at 100; delete by id); `src/routes/sourcemaps.ts:42-136` (all four operations gate only on membership, no role check).
- **Description**: each distinct `(release, fileUrl)` pair can hold 5 MB of JSON in the DO's SQLite database. There is no limit on the number of pairs, so an authenticated member can upload until the DO's storage quota is exhausted — at which point *all* writes for that project fail, including event ingestion (the DO is single SQLite database per project; errors become permanent data loss for the retention window). Additionally, source maps are de-minified source code; any `member` (lowest role) can download them via `GET /api/projects/:slug/sourcemaps/resolve?release=…&fileUrl=…`.
- **Production exploitation scenario**: a disgruntled member (or stolen member token) uploads thousands of 5 MB junk source maps across invented release names, filling the DO's storage; ingestion for the project starts failing silently (`/ingest` returns 500s); meanwhile the same member downloads every genuine source map — full pre-minification source of the customer's application — before leaving.
- **Remediation**: enforce a per-project quota (count + total bytes; e.g., `SELECT COUNT(*), COALESCE(SUM(size),0) FROM source_maps` checked before insert, reject with 409/413); restrict upload/delete to owner/admin (keep read for members if the dashboard resolves client-side, but consider admin-only download of full content); consider storing content in R2 with the DO holding metadata; add a project-level `Content-Length` guard at the route before `c.req.json()` parses an arbitrarily large body (the 5 MB check runs only after the whole body has been read, parsed, and re-serialized into the DO request).

### 7. [MEDIUM] Merge endpoint accepts an unbounded `issueIds` array — unbounded SQL, statement count, and DO CPU time (bulk-update caps at 100; merge caps at nothing)

- **Where**: `src/routes/issues.ts:278-313` (only checks `length >= 2`); `src/durable-objects/project-state.ts:1921-2083` — `placeholders` built from the full array (L1942-1944, repeated in five more statements L1952-2052), plus three per-secondary-issue loops issuing 1–N statements each (stats L1966, users L1983, environments L2006).
- **Description**: `PATCH …/issues/bulk` correctly rejects >100 ids (`project-state.ts:794-799`), but the merge path builds `IN (?,?,…,?)` with as many placeholders as supplied and runs quadratic per-id work. A 100k-element array yields a multi-megabyte SQL statement plus hundreds of thousands of DO-stored statements in one request — DO wall-clock/CPU limits are per-request and the DO is single-threaded, so this blocks ingestion and all reads for the project while it churns.
- **Production exploitation scenario**: a member POSTs `/api/projects/:slug/issues/merge` with `primaryIssueId` and 200,000 fake UUIDs; the DO spends its entire CPU budget building/executing the giant statement (or fails on statement-length limits), returning 500s; repeated at modest rate, this is a cheap denial of service against a project's error tracking exactly when it's most needed.
- **Remediation**: mirror the bulk cap (`issueIds.length > 100 → 400 too_many_issues`); additionally require every id to exist before mutating (it already validates existence — keep it before any UPDATE); wrap the whole merge in one transaction so partial failures can't strand half-merged state.

### 8. [LOW] CORS: wildcard origin combined with `credentials: true` on all `/api/*` routes

- **Where**: `src/index.ts:30-38`.
- **Description**: `cors({ origin: '*', credentials: true, … })`. Browsers refuse credentialed responses under `ACAO: *`, and the API authenticates via `Authorization` headers (not cookies), so this is not directly exploitable today — but it advertises every endpoint to every origin, silently breaks if cookie auth is ever added, and makes any future token-in-JS mistake instantly world-readable. It also signals a misconfigured policy rather than an intentional one.
- **Production exploitation scenario**: the dashboard later moves refresh tokens to cookies (a common evolution); wildcard-CORS-with-credentials then either breaks login or, if "fixed" naively by reflecting the Origin header, becomes a full cross-site read primitive over the API.
- **Remediation**: set `origin` to the known dashboard origin(s) (env-configured), drop `credentials` unless cookies are introduced, and add `maxAge`. Verify OPTIONS preflight returns the same restrictive policy.

### 9. [LOW] Issue search `LIKE` does not escape `%`/`_` wildcards (tag-values does it correctly) — wildcard injection and scan amplification

- **Where**: `src/durable-objects/project-state.ts:648-651` (`title LIKE '%${query}%' OR culprit LIKE '%…%'`, no `ESCAPE`) vs. the correct pattern at `:996-999` (`LIKE ? ESCAPE '\\'` with backslash/percent/underscore escaping in `handleGetTagValues`).
- **Description**: not SQL injection (the value is bound as a parameter) — but user-controlled `%`/`_` are interpreted as wildcards. `query=%` matches every row; `query=___` matches all 3-char-plus titles; crafted patterns (`%a%b%c%d%e%`) force pathological LIKE backtracking on large `issues` tables, and leading-`%` patterns already defeat index use. The two search paths behave inconsistently.
- **Production exploitation scenario**: a member spams `GET /api/projects/:slug/issues?query=%25a%25b%25c%25d%25e%25f%25g` — cheap CPU burn on the project DO (each request scans and string-matches the whole issues table), degrading ingestion.
- **Remediation**: reuse the `escapeLike` logic from `handleGetTagValues` in `handleGetIssues` (same `ESCAPE '\\'` clause); consider a length cap on `query` (e.g., 200 chars).

### 10. [LOW] No security headers or CSP for the dashboard; SPA fallback serves `index.html` (HTTP 200) for `/docs` and `/openapi.json`

- **Where**: `packages/workers-sentinel/wrangler.jsonc:34-40` (`assets` block with `not_found_handling: "single-page-application"`, `run_worker_first: ["/api/*", "/docs", "/openapi.json"]`); no `headers` config anywhere (no `_headers` file in the repo).
- **Description**: the dashboard ships without `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, or HSTS. Because `/docs` and `/openapi.json` are worker-first but have no Hono route, they fall through `app.get('*')` (`src/index.ts:69-72`) to the SPA handler and return `index.html` with `200 text/html` — content-type confusion for anything that treats those as JSON endpoints.
- **Production exploitation scenario**: a third-party script or compromised dependency in the dashboard bundle executes without CSP constraints (full exfil of the session/API token from `localStorage`); separately, tooling fetching `/openapi.json` gets HTML and mis-parses.
- **Remediation**: add a `_headers` file (or `assets.headers` config) with a strict CSP for the SPA (e.g., `default-src 'self'; connect-src 'self' <api-origin>`; no `unsafe-inline` if the build allows nonces/hashes), plus `nosniff`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS. Either implement `/docs` and `/openapi.json` routes or drop them from `run_worker_first`.

### 11. [LOW] Retention clock mismatch: events pruned by server `received_at`, but stats buckets keyed by client-controlled event `timestamp` — permanent stats skew and future-dated rows that outlive retention

- **Where**: `src/durable-objects/project-state.ts:337-339` (client `event.timestamp` stored as-is), `:455-462` (`getHourBucket(timestamp)` → client-controlled bucket), `:1727-1758` (alarm deletes events by `received_at < cutoff`, stats by `bucket < cutoff`), `:896-932` (`handleGetStats` reads those buckets).
- **Description**: any SDK (or anyone holding the project's public DSN key, which is all ingestion auth requires) can send events with `timestamp` arbitrarily far in the past or future. Past-dated events create stats buckets that the very next alarm deletes (stats vanish while the event row remains, since events are pruned on `received_at`); future-dated buckets are never `< cutoff` until the wall clock passes them, so `issue_stats` grows unboundedly and skews every chart. Issue `count`/`first_seen` recalculation (`:1741-1755`) then contradicts the displayed series.
- **Production exploitation scenario**: a script posts 1M events with `timestamp: 2035-…` under the project's public key: ingestion storage shows them (deleted only after 2035 minus retention), every stats graph is a wall of fake counts, and the `issue_stats` table bloats permanently — with no member-facing way to distinguish sabotage from real traffic.
- **Remediation**: clamp client timestamps to a sane window (e.g., reject or floor/ceiling ±24h against `received_at`); key retention deletes consistently on `received_at` for both tables; cap per-issue bucket count or collapse far-future buckets to "now".

---

## Integration test throughlines

Concrete scenarios the current suite does **not** cover (verified by reading `test/*.test.ts`). These matter — the existing tests prove route auth (401s) and happy paths only.

1. **Member-role event redaction (Finding 1)**
   `POST /api/:projectId/envelope/` with an event whose `request.headers.Authorization = 'Bearer secret-token'`, `request.env = {STRIPE_KEY: 'sk_live_…'}`, `user.email = 'victim@example.com'`; precondition: sender holds the project DSN, reader is a `member`-role user.
   `GET /api/projects/:slug/events/:eventId` and `GET /api/projects/:slug/events/latest` → expect redacted headers/env and no raw `sk_live_…` anywhere in the response (today: fully present).

2. **Webhook redirect does not re-deliver (Finding 4)**
   Configure `webhookUrl = https://attacker.test/hook` (owner/admin PATCH); target responds `307` → `http://169.254.169.254/latest/meta-data` (or a second observer origin). Send an event creating a new issue; precondition: none.
   Expect: no second outbound request leaves the worker (assert via fetch mock counting: exactly one POST, redirect not followed). Today: followed.

3. **Negative limit cannot dump (Finding 3)**
   Ingest 150 events; `GET /api/projects/:slug/events/latest?limit=-1` as any member.
   Expect: ≤100 rows (or 400). Today: all 150 with full payloads in one response.

4. **Project deletion purges the DO (Finding 2)**
   Create project, ingest events, upload sourcemap, add comment; `DELETE /api/projects/:slug` (owner); then, in the test harness only, fetch the ProjectState stub `idFromName(project.id)` → `/events/latest`.
   Expect: empty/404 and `source_maps` gone. Today: all data still present.

5. **Merge array cap (Finding 7)**
   `POST /api/projects/:slug/issues/merge` with `issueIds` of length 10,000 (2 valid + junk).
   Expect: 400 (mirror of bulk's `too_many_issues`). Today: giant SQL statement executes/throws.

6. **Sourcemap quota + role gating (Finding 6)**
   Member uploads N × 5 MB source maps across distinct `(release, fileUrl)` until quota; expect 413/409 with a clear error, and ingestion still succeeding.
   Separately: `member` calls `GET /api/projects/:slug/sourcemaps/resolve?…` → expect 403 under admin-only policy (today: 200 with full source).

7. **Cascade assertions after issue deletion (hardening / current test-name mismatch)**
   `comments.test.ts:257` is *named* "should delete comments and activity when issue is deleted" but only asserts the issue 404s. Extend: after issue delete, `GET …/issues/:issueId/events` → empty, `GET …/issues/:issueId/comments` → empty, and `GET /api/projects/:slug/tags` no longer counts the deleted issue's tag values. (FK cascades do fire in workerd — Cloudflare docs confirm FK enforcement — but nothing pins it; a schema refactor that drops a FK clause would pass today's suite.)

8. **Webhook URL not disclosed to members (Finding 5)**
   Owner sets `webhookUrl`; `member` calls `GET /api/projects`.
   Expect: `webhookUrl` masked/absent for the member, full value for owner/admin. Today: full URL to any member.

9. **Cross-project isolation on sourcemaps (defense-in-depth for routes)**
   Member of project A calls `GET /api/projects/B-slug/sourcemaps` with A's token.
   Expect: 404 `project_not_found` (the `getProjectWithAccess` JOIN should enforce this — currently untested for sourcemaps specifically).

10. **Retention consistency under hostile timestamps (Finding 11)**
    Ingest event with `timestamp` 10 years in the past + `received_at` now; run alarm; expect the event row still present (retention on `received_at`) **and** its stats bucket not double-deleted / or policy-adjusted outcome pinned explicitly. Today behavior is emergent and untested.

---

## Non-issues / hardening notes

**Checked and sound** (with caveats):

- **SQL injection: clean.** Every dynamic filter/value is bound (`?` params) across `project-state.ts` (issues L621-671, events L836-845, tags L990-1002, releases L1023-1031, activity L1288-1299); `ORDER BY` uses the `ALLOWED_SORT_FIELDS` whitelist (L594-601, L617) with fixed `DESC`; `IN (...)` placeholder strings are generated, never from client text (L806, L1942). The DO router is a fixed `switch` on path (L228-306) — no path-based SQL. `handleUpdateIssue`/`handleUpdateFilter` build `SET` clauses only from hardcoded column fragments with bound values (L731-748, L1514-1543).
- **FK cascades do fire** in production (workerd enforces foreign keys — Cloudflare D1 docs state enforcement equivalent to `PRAGMA foreign_keys = on`, and the same SQLite engine backs DOs), so `ON DELETE CASCADE` on issue delete covers events/tags/stats/users/comments/activity/release_issues. Caveats: the test suite never asserts child-row deletion (see throughline 7), and `handleMergeIssues`'s comment "CASCADE removes their stats, users, environments" (L2051) is misleading — those rows are manually merged first; explicit child deletes would be more robust than relying on schema-level cascade.
- **Sourcemap names/paths: no traversal surface.** `release`/`fileUrl` are stored as opaque TEXT and only ever compared for equality (`UNIQUE(release, file_url)`, lookups at L1885-1889); no filesystem or key-space concatenation. Content is `JSON.parse`-validated (L1820-1824) and capped at 5 MB (L1816-1818).
- **RPC surface: minimal and correctly gated.** `src/rpc.ts` exposes exactly one method (`captureEnvelope`), which validates the DSN public key against AuthState and requires `projectId === project.id` (L99-102) before ingesting; there is no read/delete surface via RPC; non-RPC `fetch()` always 400s (L146-148). Service-binding callers are same-account workers, and their effective credential is the DSN key — identical power to public HTTP ingestion, as documented. Rate limiting still applies inside the DO's `/ingest`.
- **Authz on all slice routes:** every issues/events/releases/sourcemaps route resolves the project through `getProjectWithAccess`, which JOINs `project_members` on the authenticated user (`auth-state.ts:438-448`) — a non-member gets 404. Webhook-URL *setting* and project deletion are owner/admin-gated (`auth-state.ts:530, :568-574`). Comment deletion checks ownership (`project-state.ts:1262-1264`).
- **Ingestion-side rate limiting** exists per project/hour when configured (`checkRateLimit`, L1638-1664) — note default is **unlimited** (`max_events_per_hour` unset → allowed), so operators must set it.

**Defense-in-depth ideas / minor robustness gaps** (no finding-level severity):

- `handleUpdateIssue` accepts any `status` string — no enum validation (bulk-update validates; single update doesn't) → garbage statuses pollute filters. Whitelist `unresolved|resolved|ignored`.
- `handleGetActivity` cursor `cursor.split('|')` (L1293): a cursor without `|` pushes `undefined` as a bind param → DO 500. Guard malformed cursors with 400.
- `releases.ts:77` `decodeURIComponent(version)` throws `URIError` on malformed `%` sequences → unhandled 500. Wrap in try/catch.
- `handleGetComments`/`handleGetActivity` don't verify the parent issue exists — harmless while cascades fire, but they'd happily serve orphans if a schema change ever dropped a FK; add an existence check or an integration test.
- `hashUserIdentifier` (L1586-1600) is unsalted SHA-256 of `id|email|ip|username` — emails/IPs are low-entropy and trivially dictionary-reversed, so the hashing is cosmetic; since raw identifiers are retained in `events` anyway (Finding 1), consider a keyed HMAC (HMAC-SHA-256 with a per-deployment secret) if `issue_users` is ever meant to be non-identifying.
- Webhook payload content (`lib/webhook.ts:31-44`) embeds the raw exception message (SDK-controlled) as the Slack/`text` field — message content is attacker-controllable through any client SDK; consider length-capping and neutralizing markup in `text`.
- `events/latest` has no cursor (only a limit) — add keyset pagination for consistency with the other lists once negative-limit clamping lands.
- Observability (`wrangler.jsonc:7-9`) is enabled with defaults: `console.error` lines carry webhook response bodies (`webhook.ts:57`) and raw DO error messages (`project-state.ts:308-313`) into Workers Logs. Truncate/redact before logging; consider sampling. (Folded into Finding 4/10 remediations.)
- `compatibility_date: "2026-01-18"` with `nodejs_compat` — no `limits.cpu_ms` set; consider pinning a CPU limit to bound worst-case request cost.
- Internal DO endpoints (`http://internal/*`) are unauthenticated by design (bindings-only reachability). If a future route ever forwards a client-controlled path/host into a DO fetch, this becomes critical; keep an architectural lint for that pattern.
- Public DSN `public_key` exposure to members (list/get project) matches the Sentry model (public key ≠ secret) — non-issue; the webhook URL is the actual secret-like field (Finding 5).

**Sources**: repo files cited inline; foreign-key enforcement — Cloudflare D1 docs (`developers.cloudflare.com/d1/sql-api/foreign-keys/`, `developers.cloudflare.com/d1/sql-api/sql-statements/`) and workerd discussion confirming D1/workerd behavior applies to DO SQLite.
