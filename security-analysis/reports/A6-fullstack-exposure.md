# A6 — Full-Stack Exposure

## Summary

**Scope.** Full journey of attacker-controlled Sentry event content (ingestion → Durable Object storage → API serialization → Vue dashboard rendering) and of user/account data at rest (AuthState: users, sessions, API tokens, projects, project_members), per the A6 slice assignment:

- `packages/workers-sentinel/src/durable-objects/auth-state.ts` (all 30 handlers)
- `packages/workers-sentinel/src/routes/{issues,events,sourcemaps,releases}.ts` (plus `index.ts` CORS, `middleware/auth.ts`, `auth.ts`, `members.ts`, `projects.ts`, `admin.ts`, `ingestion.ts`, `rpc.ts`, `lib/webhook.ts`, `lib/fingerprint.ts` for the full chain)
- `packages/dashboard/src/**` — every view, `api/client.ts`, `stores/auth.ts`, `stores/projects.ts`, `lib/sourcemap-resolver.ts`, `router/index.ts`
- `packages/workers-sentinel/test/*.test.ts` read as evidence of covered/uncovered behavior

**Method.** Static analysis only (per instructions; local dev stack on 127.0.0.1:25304 untouched). Line-by-line reads of the DOs and routes; template-level sweep of every dashboard view for XSS sinks (`v-html`, `innerHTML`, `eval`, `new Function`, dynamic `:href`/`:src`, `window.open`, blob URLs — none found); verification of the installed Hono 4.11.3 CORS middleware source (`node_modules/.pnpm/hono@4.11.3/.../dist/middleware/cors/index.js`) to confirm actual header emission; cross-referenced test files for authorization coverage.

**Confidence.** High for everything stated with a file:line (directly read code). The dashboard XSS conclusion ("no sink") is high-confidence for the *current* template set but is a negative result — a single future `v-html` reintroduces the risk (see hardening notes). No runtime/dynamic testing was performed, so exploitation scenarios are reasoned, not reproduced.

**Headline results.** No end-to-end stored-XSS chain exists today: every attacker-influenced field (exception type/value, messages, tags, breadcrumbs, stack frames + context lines, user id/email/ip) reaches the browser only through Vue text interpolation and is HTML-escaped; the raw-event view is `JSON.stringify` inside `<pre>{{ }}</pre>`; the sourcemap resolver parses mappings with `@jridgewell/trace-mapping` and never evaluates or renders source content. The real exposures are at rest and in access control: passwords and API tokens hashed with **unsalted SHA-256**, a **role gap letting any project member trigger event-data destruction** via retention settings, verbatim persistence of end-user PII (and any request secrets the monitored app's SDK chooses to send) with no scrubbing, and a spec-violating CORS policy (`*` + credentials) that is currently mitigated only by the header-token auth model.

---

## Findings

### [HIGH] H-1 — Passwords and API tokens stored as single unsalted SHA-256; non-constant-time verification

**Where.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:1081-1092` (`hashPassword`/`verifyPassword`); schema at `auth-state.ts:8` (`password_hash`) and `auth-state.ts:52` (`token_hash`); used at `auth-state.ts:180` (register), `auth-state.ts:244` (login), `auth-state.ts:677` (API-token creation), `auth-state.ts:769` (API-token validation).

**Description.** `hashPassword` is one `crypto.subtle.digest('SHA-256', password)` — no salt, no key stretching, no pepper. `verifyPassword` compares hex strings with `===` (not constant-time). Consequently:

- All users with the same password share the same hash (no per-user salt).
- SHA-256 is fast: modern GPUs compute billions of candidates/second, so any disclosure of the `users` (or `api_tokens`) table converts directly into mass offline password recovery, including rainbow-table and cross-installation dictionary attacks.
- API tokens (`wst_…`, 64 hex chars of CSPRNG output at `auth-state.ts:674`) are high-entropy, so brute-forcing them is infeasible — but their hashes are still unsalted, identical across revocation/recreation patterns only by chance, and unprotected against a targeted pre-image attempt if the token ever has low entropy in a future code path.

**Concrete production exploitation scenario.** An operator's Durable Object SQLite state (`persist/` in local dev; Cloudflare-side DO storage in production), a backup, a support bundle, or any future read primitive (e.g., an SSRF into `http://internal/*` or a SQL-injection-style regression) discloses the `users` table. The attacker cracks the `password_hash` column offline at SHA-256 speed — typical human passwords fall in minutes-to-hours — and logs in as the (first-registered, admin) user, gaining full project/admin access (`admin.ts:18` checks only `auth.user.role`). Because sessions live 30 days with no rotation, nothing forces re-authentication afterward.

**Remediation.** Replace `hashPassword` with PBKDF2-HMAC-SHA-256 via `crypto.subtle.deriveBits` (available in Workers) with a per-user random salt and ≥ 600k iterations (or scrypt/argon2 via WASM if the budget allows); store `pbkdf2$iter$salt$hash`; compare with a constant-time check. For API tokens, store HMAC-SHA256(token, server_secret) or salted PBKDF2 — HMAC is sufficient for high-entropy tokens and avoids iterating on every request. Migrate lazily: re-hash on next successful login; force reset for dormant accounts.

---

### [MEDIUM] M-1 — Any project member can change retention and rate-limit settings (member-triggered event-data destruction)

**Where.** `packages/workers-sentinel/src/routes/projects.ts:142-246` (PATCH `/api/projects/:slug`); `packages/workers-sentinel/src/durable-objects/project-state.ts:1687-1699` (`handleUpdateConfig`), `:1775-1801` (`handleUpdateSettings`); contrast with the correctly-gated webhook path `auth-state.ts:567-574` and member routes `routes/members.ts:98,134,170`.

**Description.** PATCH `/api/projects/:slug` verifies only that the caller is a member of the project (`get-project` with `userId` → membership join, `auth-state.ts:438-448`). For `webhookUrl` it then delegates to `update-project`, which enforces `owner|admin` inside the DO. But `maxEventsPerHour` and `retentionDays` are forwarded directly to ProjectState `config/update` / `settings/update`, which perform **no role check at all** (they trust the service-binding caller). A plain `member` can therefore:

- set `retentionDays: 1` → the next DO alarm (`project-state.ts:1726-1759`) deletes every event older than 24h, recalculates issue counts, and deletes issues with count 0 — irreversible destruction of the project's error history;
- set `maxEventsPerHour: 0` (disable the abuse quota) or `1` (drop nearly all inbound events via `checkRateLimit`, `project-state.ts:1638-1664`).

**Concrete production exploitation scenario.** A low-privileged teammate (added with role `member` through the normal invite flow at `POST /api/projects/:slug/members`) runs `curl -X PATCH .../api/projects/acme -H "Authorization: Bearer <session>" -d '{"retentionDays":1}'`. The server returns `{retentionDays: 1}` with 200. Within a day (next alarm tick), all events older than 24h are gone — incident forensics data destroyed by a role that is documented (and enforced elsewhere) as non-managing. Test evidence of the gap: `projects.test.ts:367-445` exercises retention PATCH only as the owner; no test asserts a member is rejected.

**Remediation.** Enforce `owner|admin` for both settings — either in `routes/projects.ts` (via the same `getProjectAndRole` helper `members.ts:14-60` uses) or, better, inside `handleUpdateConfig`/`handleUpdateSettings` by passing the caller's project role into the DO, mirroring `update-project`. Add the missing member-rejection tests.

---

### [MEDIUM] M-2 — CORS allows every origin with credentials enabled on all `/api/*`

**Where.** `packages/workers-sentinel/src/index.ts:30-38`; verified against installed `hono@4.11.3` `dist/middleware/cors/index.js` (string `origin === "*"` → `findAllowOrigin` returns the literal `*` regardless of request Origin; `credentials: true` sets `Access-Control-Allow-Credentials: true`; `allowHeaders` includes `Authorization`).

**Description.** Every `/api/*` response carries `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials: true`, and preflights from any origin are answered with `Authorization` allowed. This combination is invalid per the Fetch spec. Practical impact today is limited because authentication is a Bearer token in `localStorage` (never a cookie):

- Credentialed (cookie-based) cross-origin *reads* are still blocked by browsers, since the literal `*` is not honored with `Access-Control-Allow-Credentials`.
- Classic CSRF (ambient credentials) does not apply — an attacker page cannot attach the victim's `Authorization` header without triggering a preflight it cannot satisfy without knowing the token.

However: (a) if cookie/session auth is ever introduced (a common hardening move *away* from localStorage), cross-origin state-changing requests will still **execute** (only reads are blocked), turning this into a live CSRF surface; (b) the config allows any origin's JavaScript to drive authenticated endpoints whenever it possesses a token (e.g., a token leaked via `Referer`, `postMessage`, or a compromised dependency in another app on the same host), with no origin-based second factor; (c) it signals permissive defaults that tend to spread.

**Concrete production exploitation scenario.** Post-exploitation amplifier rather than a primary vector: an attacker who obtains a victim's 30-day token (see M-3) through any leak channel can exfiltrate data and issue destructive API calls from *their own* origin with zero CORS friction — no origin allowlist ever rejects them.

**Remediation.** Replace `origin: '*'` with the dashboard's own origin (or a function validating against a configured allowlist), and set `credentials: true` only when the origin matches. This preserves browser-SDK ingestion (SDKs post without credentials; the wildcard on the ingestion path can be kept if desired by scoping the permissive CORS to `/api/:projectId/envelope*` only).

---

### [MEDIUM] M-3 — Session model maximizes XSS/leak blast radius: token in localStorage, 30-day non-rotating sessions, no revocation-all, open registration with first-user-admin bootstrap

**Where.** `packages/dashboard/src/api/client.ts:12-13,21-24` (localStorage token, Bearer header); `packages/dashboard/src/stores/auth.ts:25,62,80` (persist token); `packages/workers-sentinel/src/durable-objects/auth-state.ts:1056-1075` (`createSession`: 30 days, no rotation, no reuse detection); `auth-state.ts:152-211` (open registration; first user silently becomes `admin` at `auth-state.ts:176-185`); `routes/auth.ts:61-81` (logout requires the token itself).

**Description.** The session token is a bearer credential with a 30-day lifetime, stored in `localStorage` (readable by any XSS on the dashboard origin — and the dashboard deliberately renders attacker-supplied error data), never rotated, and revocable only one-at-a-time by presenting the token itself. There is no refresh flow, no session listing, no "log out everywhere," no password change, and no password reset (verified: no such handlers exist in `auth-state.ts` dispatch `auth-state.ts:91-133`). Registration is open to anyone; the first registrant becomes admin, so a publicly deployed instance can be captured by whoever reaches it first.

**Concrete production exploitation scenario.** (1) A single future XSS in any view that renders event content converts directly into persistent account takeover: `localStorage.getItem('token')` exfiltration, then 30 days of full API access from anywhere (compounding M-2). (2) On a fresh public deploy, an attacker registers before the operator and becomes the instance admin (`role: 'admin'`, `auth-state.ts:185`), then invites themselves to projects via member add (`members.ts:89-121`) and reads all error data.

**Remediation.** Move the token to an `HttpOnly; Secure; SameSite=Strict` cookie (also resolves M-2's CSRF caveat when combined with an origin allowlist and CSRF tokens), or at minimum keep localStorage but add: short-lived access tokens + refresh rotation, session listing/revocation, and re-auth for sensitive actions. Add a registration gate (invite codes / first-run setup wizard) and an explicit admin bootstrap.

---

### [MEDIUM] M-4 — End-user PII and monitored-app request secrets persisted verbatim and exposed to every project member; `/security` advertises scrubbing that does not exist

**Where.** `packages/workers-sentinel/src/durable-objects/project-state.ts:415-432` (events row: `user_id`, `user_email`, `user_ip` plaintext columns **plus** the entire raw event JSON in `data`, including `event.request` — headers/cookies of the crashing app — as sent by the SDK); `project-state.ts:863-894` (raw `data` returned verbatim by `/event`, `/issue/events`, `/events/latest`); `packages/dashboard/src/views/EventDetail.vue:66` (raw JSON rendered to any member); `packages/workers-sentinel/src/routes/ingestion.ts:185-190` (`GET /api/{projectId}/security` returns `{ scrubData: true }` — no scrubbing is implemented anywhere); `packages/workers-sentinel/src/durable-objects/auth-state.ts:821-848` (member list returns every member's email + name to any member).

**Description.** Ingestion performs zero redaction: whatever the monitored application's SDK includes (user emails, usernames, IP addresses, request headers such as `Authorization`/`Cookie`, form bodies in breadcrumbs) is stored as-is and later served — as structured JSON — to **every** project member, and rendered (escaped, but fully readable) in the dashboard. The `security` endpoint's `scrubData: true` claim is false advertising to SDKs that query it. Separately, `list-project-members` exposes all members' account emails to the lowest-privileged member (common-but-questionable for multi-tenant teams; `handleListUsers` for admins is the only gated variant, `auth-state.ts:1032-1054`).

**Concrete production exploitation scenario.** A monitored production app crashes during an authenticated request; its SDK records `request.headers.authorization: Bearer <prod-api-token>` or `request.cookies.session=...` in the event. Any `member`-role user of the Sentinel project (e.g., a contractor added to triage frontend errors) opens Event Detail and reads the production credentials from the JSON blob. Alternatively, a malicious *end user* of the monitored app deliberately triggers errors with crafted `user.email` / breadcrumb content, planting PII-lookalike or credential-bait content into the team's dashboard and webhooks.

**Remediation.** Implement server-side scrubbing at ingest (mask `request.headers.{authorization,cookie,x-*}`, `request.cookies`, and configured PII fields before persisting — this also makes `scrubData: true` true); store only hashed/truncated user identifiers in the indexed columns; consider a "revealed on click" pattern for sensitive fields with audit; restrict member emails to owner/admin or make them opt-in.

---

### [LOW] L-1 — Internal error messages reflected to clients in 500 responses

**Where.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:140-149` and `project-state.ts:307-316` (catch-all returns `error.message`); surfaced verbatim by `packages/dashboard/src/api/client.ts:35` (`data.message || data.error`) and rendered in views (e.g., `Issues.vue:194`, `ProjectSettings.vue:100`).

**Description.** Any thrown exception inside a DO handler (SQLite constraint violations, type errors on malformed JSON bodies) is returned to the HTTP client with its raw message. SQLite messages can disclose schema details (table/column names), and driver errors can leak internal paths/state. A trivially triggerable instance is the duplicate-`event_id` case: the ingest path increments the issue counter *before* inserting the event (`project-state.ts:385-389` precedes `:415-432`), so an attacker posting an envelope with `event_id` equal to an existing event's id causes `INSERT` to throw a UNIQUE-constraint error — the DO returns 500 with the SQLite message, and the issue's `count` is silently inflated relative to stored events (integrity drift).

**Concrete production exploitation scenario.** An unauthenticated attacker with a project DSN (public by design) POSTs envelopes re-using known event IDs (event IDs are client-chosen, `project-state.ts:337`): each request yields a 500 with `UNIQUE constraint failed: events.id`-style internals and inflates issue counts, polluting stats and retention recalculation (`project-state.ts:1741-1745` recounts from events, partially self-correcting only after an alarm).

**Remediation.** Return opaque `{ error: 'internal_error' }` (log the detail via `console.error`, which already happens); handle duplicate event IDs explicitly (409/ignore-dedup semantics, ideally with an `INSERT OR IGNORE` and conditional counter increment).

---

### [LOW] L-2 — "Anonymized" user identifiers are unsalted, truncated SHA-256 (reversible by dictionary)

**Where.** `packages/workers-sentinel/src/durable-objects/project-state.ts:1586-1600` (`hashUserIdentifier`), feeding `issue_users` / `user_count` (`project-state.ts:551-582`).

**Description.** End-user identifiers (id, email, IP, or username) are hashed with plain SHA-256 and truncated to 32 hex chars for the "unique users affected" metric. Emails and IPs have tiny dictionaries; an attacker with any read access to `issue_users` (or a future dump) can re-identify affected users offline. The privacy intent is also undermined by M-4: the same identifiers sit in plaintext columns and raw event JSON anyway.

**Remediation.** Use HMAC-SHA256(identifier, per-install secret) — keyed, so dumps alone don't allow dictionary attacks; drop the plaintext duplicates per M-4.

---

### [LOW] L-3 — Webhook pipeline forwards attacker-controlled titles verbatim; `test-webhook` echoes target responses and enables edge-origin probing

**Where.** `packages/workers-sentinel/src/lib/webhook.ts:29-32` (`text` embeds `issue.title` + `culprit`, both derived from attacker exception content — `lib/fingerprint.ts:54-109`); `routes/ingestion.ts:152-176` (auto-delivery on new issues); `routes/projects.ts:284-345` (test-webhook POSTs the configured HTTPS URL from the Worker and returns the target's status **and body** to the caller).

**Description.** (a) Anyone who knows a project DSN chooses the exact bytes of `issue.title` (exception `type`/`value`, truncated to ~100 chars) that get delivered to the team's Slack/webhook receiver; receivers that render the `text` field as HTML/Markdown (Slack sub-warnings aside, many custom receivers don't escape) give the reporter stored-XSS-in-the-chat or phishing formatting in the team's alert channel. (b) `test-webhook` lets an owner/admin make the Worker fetch any HTTPS URL and reflects the response body back — a request-forgery/oracle primitive (e.g., probing third-party endpoints with Cloudflare egress, or pulling content into the dashboard's error message) limited to HTTPS and to privileged callers.

**Concrete production exploitation scenario.** Attacker with a leaked DSN (DSNs live in client bundles by design) sends `{"exception":{"values":[{"type":"Error","value":"click <b>here</b> http://evil.example"}]}}`; a new issue fires the webhook; a custom receiver renders bold text/link into the on-call channel, laundering the attacker's content through a trusted channel.

**Remediation.** Structure webhook payloads so receivers use dedicated non-`text` fields for titles, or escape/strip markup before embedding; don't echo the target body from `test-webhook` (return status only); optionally restrict webhook hosts.

---

### [LOW] L-4 — `/api/auth/me` rejects API tokens (session-only introspection inconsistency)

**Where.** `packages/workers-sentinel/src/routes/auth.ts:84-110` (calls `validate-session` directly), vs `middleware/auth.ts:29-47` which accepts both `wst_` tokens and sessions for `/api/projects/*` and `/api/admin/*`.

**Description.** A valid `wst_` API token works for every protected project/admin route but gets 401 ("Invalid or expired session") from `GET /api/auth/me`. Not exploitable; it is a correctness gap that breaks API-token tooling which bootstraps identity via `/me`, and a mild oracle inconsistency (token validity is answerable only through a project-scoped call).

**Remediation.** Route `/api/auth/me` through `authMiddleware` (keeping the token-management session-only guard at `auth.ts:115-128`, which is correct and tested — `api-tokens.test.ts:318-323`).

---

### [INFO] I-1 — No stored-XSS sink exists in the current dashboard (verified negative), with the standard caveat

**Where.** All 16 `.vue` files under `packages/dashboard/src/**` (swept for `v-html`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, dynamic `:href`/`:src`, `window.open`, blob/`URL.createObjectURL` — zero matches); key rendering sites: `EventDetail.vue:66`, `IssueDetail.vue:298-306, 477-515, 521-542, 644-676`, `Issues.vue:464-499` (DSN quickstart interpolation), `Releases.vue:106`.

**Description.** The full attacker-content journey ends in escaped interpolation: exception values/titles/culprits (`IssueDetail.vue:302-306`), stack-frame filenames/functions/context lines (`IssueDetail.vue:478-515`), breadcrumbs (`IssueDetail.vue:533-534`), user id/email/ip (`IssueDetail.vue:648-659`), tags (`IssueDetail.vue:667-674`), and the entire raw event (`EventDetail.vue:66`). Dynamic `RouterLink :to` targets are built exclusively from route params and internal IDs, not event fields. Vue's auto-escaping covers these; there is no `v-html` to defeat it.

**Remediation (defense-in-depth).** Add a Content-Security-Policy header (`default-src 'self'`) on the SPA responses from the Worker's assets path so that a future template regression or dependency compromise cannot immediately become script execution; add a lint rule (`v-html` is off by default in some ESLint Vue configs — enforce with `vue/no-v-html`) and a UI-level regression test asserting script-carrying event fields render inert.

### [INFO] I-2 — LIKE wildcard injection in issue search (cosmetic)

**Where.** `packages/workers-sentinel/src/durable-objects/project-state.ts:648-651`.

**Description.** The `query` parameter is interpolated into `%${query}%` LIKE patterns without escaping `%`/`_`, so a caller can force full scans or odd matches. Values are parameterized — no SQL injection. Negligible impact at current data volumes; note for completeness.

### [INFO] I-3 — Ingestion `event_id` is client-controlled (enables L-1's duplicate-id path and ID squatting)

**Where.** `packages/workers-sentinel/src/durable-objects/project-state.ts:337` (`event.event_id || randomUUID()`).

**Description.** SDK-clients choose event IDs. Combined with L-1's insert ordering this yields the 500/counter-drift behavior; it also permits deliberate ID collisions across issues. Server-side generation (or `INSERT OR IGNORE` + dedup) closes it.

---

## Integration test throughlines

These scenarios are **not** covered by the current suite (verified against `auth/members/projects/issues/events/sourcemaps/releases/admin/api-tokens/ingestion` tests) and pin down the findings above. Format: method + path + preconditions + expected result (with current behavior where it deviates).

1. **Stored-XSS round-trip (I-1 regression guard).**
   `POST /api/{projectId}/envelope/` (DSN auth) with an event whose `exception.values[0].value`, `message`, `tags['x']`, `breadcrumbs[0].message`, and `user.email` all contain `<img src=x onerror=window.__pwned=1>` and `javascript:alert(1)` payloads → then `GET /api/projects/:slug/issues/:issueId/events` and `GET /api/projects/:slug/events/:eventId` as a member. **Expected:** payloads present verbatim in JSON (they are, correctly, JSON-encoded); a component test mounting `IssueDetail.vue`/`EventDetail.vue` with this data asserts `window.__pwned` stays undefined and no `<img>` node appears — i.e., no sink is (re)introduced.

2. **Member cannot change retention/rate-limit settings (M-1).**
   `PATCH /api/projects/:slug` with `{"retentionDays": 1}` and then `{"maxEventsPerHour": 0}`, Authorization = session of a user whose project role is `member`. **Expected:** 403. **Current:** 200 and the settings change (destructive on the next alarm). Existing `projects.test.ts` covers only the owner path — add the member-rejection case.

3. **Duplicate `event_id` envelope handling (L-1, I-3).**
   `POST /api/{projectId}/envelope/` twice with the same client-chosen `event_id`. **Expected:** second request returns a non-500, non-leaking status (409 or idempotent 200) and the issue `count` matches stored events. **Current:** DO returns 500 with a SQLite error message surfaced by `GET`-path handlers, and the count inflates.

4. **CORS policy shape (M-2).**
   `OPTIONS /api/projects` with `Origin: https://evil.example`, `Access-Control-Request-Method: DELETE`, `Access-Control-Request-Headers: authorization`. **Expected:** no `Access-Control-Allow-Origin` for unlisted origins (allowlist). **Current:** `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true` + `Authorization` allowed.

5. **Member-list email exposure policy (M-4).**
   `GET /api/projects/:slug/members` as a `member`-role user on a project with ≥3 members. **Expected (policy decision):** own identity only, or emails restricted to owner/admin. **Current:** full email + name list of all members returned to any member.

6. **Secret/PII scrubbing at ingest (M-4).**
   `POST /api/{projectId}/envelope/` with `request.headers.authorization`, `request.cookies`, and `user.ip_address` populated → `GET /api/projects/:slug/events/:eventId`. **Expected:** sensitive fields masked/redacted server-side (and `GET /api/{projectId}/security` reports truthful scrubbing). **Current:** everything stored and returned verbatim.

7. **API token on `/me` (L-4).**
   `GET /api/auth/me` with `Authorization: Bearer wst_…` (valid token). **Expected:** 200 with the token's user. **Current:** 401. (Also assert `POST /api/auth/tokens` with a `wst_` token stays 403 — already covered, keep as a throughline anchor.)

8. **Cross-project isolation on the A6 routes.**
   As user B (member of project X only): `GET /api/projects/:slugY/issues`, `/issues/:id`, `/issues/:id/events`, `/events/:eventId`, `/sourcemaps`, `/sourcemaps/resolve?...`, `/releases`, `/releases/:version` where the ids belong to project Y. **Expected:** 404/403 throughout. Current suite covers 401 (unauthenticated) and one member-visibility case (`members.test.ts:274-299`); add the cross-project object-ID cases — the DOs themselves do no membership checks, so a future route refactor that drops the `getProjectWithAccess` call would be caught only by these.

9. **Password-hash migration contract (H-1).**
   Unit/integration: after `POST /api/auth/register`, assert the stored `password_hash` is not a bare 64-hex SHA-256 (e.g., has a `pbkdf2$`-style prefix and per-user salt) and that two users with identical passwords have different hashes. (Requires DO-state inspection in `vitest-pool-workers` or extraction of the hashing function into a unit-tested module.)

10. **Webhook payload content discipline (L-3).**
    Configure `webhookUrl` to a capture receiver; `POST /api/{projectId}/envelope/` with markup in the exception value; assert the delivered payload's `text` is escaped or the raw title travels only in a structured field, and assert `POST /api/projects/:slug/test-webhook` responses do not include the target's body.

---

## Non-issues / hardening notes

**Checked and sound:**

- **Stored XSS end-to-end:** no `v-html`/`innerHTML`/`eval`/`new Function`/dynamic `href`/`src`/`window.open`/blob anywhere in `packages/dashboard/src/**`; all attacker-derived content goes through Vue's escaped interpolation (see I-1 for the one caveat: keep it that way, add CSP).
- **Sourcemap resolver client-side:** `packages/dashboard/src/lib/sourcemap-resolver.ts` fetches only same-origin API paths with `encodeURIComponent` on both query inputs, parses with `@jridgewell/trace-mapping` (pure data parsing — no code evaluation, no `sourceURL`/`eval` tricks, no `sourcesContent` rendering), and caches `TraceMap` objects; upload path `ProjectSettings.vue:117-125` reads local files via `FileReader.readAsText` only.
- **Sourcemap serving:** content is returned strictly as a JSON string field (`project-state.ts:1898-1907`, `routes/sourcemaps.ts:102-136`) — never `application/javascript`, never as a download, and validated with `JSON.parse` at upload (`project-state.ts:1820-1824`, size-capped 5MB). No content-type confusion path found.
- **CSRF:** no cookies are used for auth anywhere (`middleware/auth.ts` Bearer header; `client.ts` localStorage). Every state-changing endpoint requires the `Authorization` header, which a cross-origin page cannot attach without a preflight, and cannot obtain without the token. Logout (`routes/auth.ts:61-81`) is token-knowledge-gated. (M-2 documents what must hold for this to stay true.)
- **Mass assignment:** no profile-update endpoints exist at all; `PATCH /api/projects/:slug` maps exactly three known fields (`projects.ts:149-153`) — unknown fields are dropped; `update-project` builds its `SET` clause from a fixed allowlist (`auth-state.ts:591-604`); member role updates validate `role ∈ {admin, member}` and refuse to touch owners (`auth-state.ts:971-999`); project creation ignores extra body fields. No user-controlled column reaches SQL unscreened.
- **Account-takeover helpers:** there is no password-reset flow (nothing to poison), no email change (so no change-without-reauth), and no token refresh logic in `stores/auth.ts` (sessions are fixed 30-day bearers — see M-3 for why that's a weakness, not a vulnerability class of its own).
- **User-data exposure in APIs:** `User` serialization (`auth-state.ts:201-208, 255-262, 306-313, 801-808`) never includes `password_hash`; API-token listing returns prefix only (`auth-state.ts:714-729`); `list-users` is admin-gated at both route and DO layers (`admin.ts:18-20`, `auth-state.ts:1037-1039`) and selects no hash columns; token revocation verifies ownership (`auth-state.ts:744-754`); token management is session-only (`routes/auth.ts:115-128`, tested at `api-tokens.test.ts:318-323`).
- **SQL construction:** every query in both DOs is parameterized; the only string-interpolated SQL fragments are an allowlisted sort field (`project-state.ts:594-599, 617`) and fixed `SET`-clause fragments from internal allowlists. Inbound filters use substring `includes`, never user regex — no ReDoS (`project-state.ts:1396-1439`).
- **Authorization architecture (routes):** every `/api/projects/*` sub-router resolves slug→project *with* the caller's userId (membership join, `auth-state.ts:438-448`) before touching ProjectState; ProjectState endpoints are unreachable except via the Worker's service bindings, and admin routes re-check role after the middleware. The known gaps are exactly M-1 and throughline #8's regression risk.
- **Dashboard auth UX:** router guard (`router/index.ts:92-113`) is cosmetic only; real enforcement is server-side (verified 401 paths in tests) — no security dependency on client-side guards.
- **Ingestion authentication:** DSN public key validated against the projects table with project-ID match (`ingestion.ts:60-82`, `rpc.ts:80-102`), per-project hourly rate limit configurable (`project-state.ts:1638-1664`), and envelope parse errors return generic messages (`ingestion.ts:108-111`).

**Defense-in-depth ideas (beyond per-finding remediations):**

- Serve a strict CSP for the SPA (`script-src 'self'; object-src 'none'; base-uri 'self'`) from the assets handler in `index.ts:69-72`.
- Add a `Vary: Origin` + explicit allowlist refactor at the same time as any cookie-session migration (M-2/M-3 are coupled).
- Consider per-user rate limits on `/api/auth/login` (currently only ingestion is rate-limited — password brute-force is unthrottled server-side, which matters more given H-1) and generic login errors already exist (`invalid_credentials`, good).
- Add honeypot/audit logging for `test-webhook` and member-role changes.
- Reconsider storing `user_email`/`user_ip` as indexed plaintext columns at all once M-4 scrubbing lands — indexed PII compounds breach impact.
- Keep the `.gitignore`d local dev state out of any support artifacts; it contains the same plaintext PII (demo credentials are documented in AGENTS.md — fine for dev, but don't ship them in production deploys).
