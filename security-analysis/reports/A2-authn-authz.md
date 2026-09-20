# A2 — AuthN/AuthZ

Analyst A2 · Static security analysis of authentication & authorization · workers-sentinel

## Summary

**Scope** (assigned slices):

1. `packages/workers-sentinel/src/routes/auth.ts`, `src/middleware/auth.ts`, `src/routes/admin.ts` — session/API-token issuance & verification, admin surface.
2. `packages/workers-sentinel/src/durable-objects/auth-state.ts` — users, sessions, API tokens, password storage, first-user admin bootstrap, member roles.
3. `packages/workers-sentinel/src/routes/projects.ts`, `src/routes/members.ts`, `src/routes/filters.ts` — project management, membership/role changes, filters.
4. Cross-cutting: CORS in `src/index.ts`, rate limiting/lockout on login, account enumeration, dashboard token storage (`packages/dashboard/src/stores/auth.ts`, `api/client.ts`).

**Method**: full manual read of the above sources; cross-checked route↔DO call chains for every `/api/projects/*`, `/api/admin/*`, `/api/auth/*` endpoint; empirically verified Hono 4.11.3 middleware wildcard behavior with a local node script (no dev-stack interaction); read `test/{auth,api-tokens,admin,projects,members,filters,rate-limiting}.test.ts` as coverage evidence. No files modified except this report. Static analysis only — no runtime testing of the running stack (127.0.0.1:25304 untouched).

**Verdict**: The route layer is consistently careful — every `/api/projects/*` handler re-checks auth, slug→project resolution always joins through `project_members`, and owner-only actions are gated. The serious weaknesses are (a) **passwords and login are protected by unsalted single-pass SHA-256 with zero online brute-force resistance**, and (b) **all authorization lives in the route layer while the Durable Object "internal" API is a completely unauthenticated trust boundary** one future route away from a full authz bypass. Add a first-registered-user-becomes-admin mechanism that is both racy and squattable.

**Confidence**: high on file/line-level facts (direct code reads, one empirical middleware check). Medium on the practical exploitability of the DO concurrency race (mechanism is certain from code structure; the interleaving window is small and was not measured at runtime — local stack was off-limits).

---

## Findings

### 1. [CRITICAL] Passwords stored as unsalted, single-pass SHA-256

**File**: `src/durable-objects/auth-state.ts:1081-1092` (`hashPassword`, `verifyPassword`), used at `:180` (register), `:244` (login), `:677`/`:769` (API tokens).

```ts
private async hashPassword(password: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);   // unsalted, fast, one pass
	...
}
```

**Description**: User passwords are hashed with plain `SHA-256(password)` — no salt, no key stretching, no memory hardness. SHA-256 is a *fast* hash: commodity GPUs compute billions of SHA-256/s, so any offline attack against the `users.password_hash` column runs at effectively unthrottled speed. The lack of salt additionally means (a) precomputed rainbow tables apply directly, and (b) identical passwords across users produce identical hashes, leaking password-equality relationships. The same function is (mis)used for API-token hashing, which is *acceptable* for 256-bit random tokens but is the wrong primitive for human passwords.

Contrast: `api_tokens.token_hash` (auth-state.ts:52,677) proves the codebase already has a "store a hash, show a prefix" pattern — passwords just never got a password-appropriate algorithm.

**Concrete production exploitation**: The AuthState singleton's SQLite storage (Durable Object persistence, or any backup/export of it) is exfiltrated — via a misconfigured wrangler export, a compromised operator machine, a future SQL-injection-style bug in another DO endpoint, or a leaked `persist/` directory. The attacker then recovers a large fraction of user passwords offline overnight on one GPU (8–10 char passwords in minutes-to-hours; users reuse passwords, so these crack other systems too). Because the first user (instance owner) is typically `admin@yourcompany`, the attacker gains the instance-admin account and every reused password. There is no password rotation path (see Finding 11) to respond to such a leak.

**Remediation**: Use a salted, memory-hard KDF — Web Crypto PBKDF2-HMAC-SHA-256 with ≥600,000 iterations is available in Workers (`crypto.subtle.deriveBits` with an explicit salt, ≥16 random bytes, per-user; verify with constant-time compare), or a WASM build of scrypt/argon2. Store `algorithm$iterations$salt$hash` strings to allow migration. Keep a distinct function for token hashing (random 256-bit inputs tolerate a single fast hash). Rotate on next login for legacy hashes.

---

### 2. [HIGH] First-registered-user-becomes-admin is racy (and squattable)

**File**: `src/durable-objects/auth-state.ts:175-196` (COUNT check → `await hashPassword` → INSERT), registration route `src/routes/auth.ts:12-35` (open, unthrottled).

**Description**: Bootstrap logic is check-then-act:

```ts
const userCount = this.sql.exec('SELECT COUNT(*) as count FROM users').one();   // L176
const isFirstUser = (userCount?.count as number) === 0;                          // L177
const passwordHash = await this.hashPassword(password);                          // L180 ← await
this.sql.exec('INSERT INTO users (... role ...) VALUES (...)', ..., role, ...);  // L187
```

Durable Objects run single-threaded, but requests *interleave at `await` points that are not storage operations*. `crypto.subtle.digest` is a native async op — while request A awaits its digest, the DO's input gate is open and request B (another concurrent `POST /api/auth/register`) is delivered, runs its own `SELECT COUNT(*)` (still 0), and both proceed to INSERT with `role='admin'`. Result: **two admins from one bootstrap**. The same structure makes the duplicate-email check (L167-173) racy: two concurrent registrations with the same email both pass the `SELECT`, and the loser hits the UNIQUE constraint → unhandled `SqlError` → 500 (see Finding 10's error leak).

No registration gating exists (no invite codes, no allowlist), so the sequential variant needs no race at all: **whoever registers first on a freshly deployed public instance *is* the admin**. Self-hosted Sentry clones get stood up on predictable hostnames (`sentinel.example.com`) before the operator creates their account; an attacker monitoring new deployments squats the instance permanently (there is no admin demotion or user-deletion path — Finding 11).

**Concrete production exploitation**: (a) Attacker scans for newly stood-up instances, registers `attacker@evil.com` seconds after deploy, becomes the permanent, irremovable instance admin, and quietly enumerates all users via `GET /api/admin/users`. (b) During the legitimate bootstrap, an attacker fires 50 parallel `POST /api/auth/register` requests with distinct emails; several interleave inside the digest window and read `COUNT(*)=0`, yielding multiple admin accounts.

**Remediation**: Make bootstrap atomic in a single SQL statement, e.g. `INSERT INTO users (..., role) VALUES (..., CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'admin' ELSE 'member' END)` — SQLite evaluates the subquery inside the INSERT, no interleaving possible. Normalize email to lowercase *before* both the duplicate SELECT and the INSERT (also fixes the 500 path). Add an explicit first-run setup mode (env-var bootstrap token, or an allowlist of first-user emails) so open registration can't crown an arbitrary squatter. Regression-test with parallel registrations asserting exactly one `role='admin'` row.

---

### 3. [HIGH] No rate limiting, lockout, or password policy on login/register

**File**: `src/routes/auth.ts:38-58` (login route — straight DO proxy), `src/durable-objects/auth-state.ts:213-265` (login handler — no attempt counters), `auth-state.ts:159-164` (register accepts any non-empty password).

**Description**: The system's only rate limiter is the *per-project event-ingestion* limiter in ProjectState (see `test/rate-limiting.test.ts` — all cases are ingestion/config). `POST /api/auth/login` and `POST /api/auth/register` have no per-IP/per-account throttling, no lockout, no CAPTCHA, and no backoff. Additionally there is no password policy at all: `a` is a valid password. Sessions last 30 days, so a single successful guess yields a month of access.

**Concrete production exploitation**: Against an internet-exposed instance, an attacker scripts `POST /api/auth/login` at high concurrency against `admin@victim.com`. Every response is a fast 401 (no delay, no counter). At even a conservative 50 req/s from rotating IPs that's ~4M guesses/day — enough to find weak/reused passwords of the known admin email (emails are cheap to enumerate: Finding 4). Workers' own platform does not throttle origin requests by default.

**Remediation**: Track failed attempts per (email, IP) in AuthState (sliding window) and return 429 with `Retry-After`; add progressive delay and temporary account-level lockout with audit logging. Enforce a minimum password length (≥12) and checked-common-password list at register (rate-limit register too — it currently allows unbounded account creation as a resource-exhaustion vector). Consider Cloudflare WAF rate rules in front as defense-in-depth.

---

### 4. [MEDIUM] Account enumeration: register 409, add-member oracle, login timing skew

**File**: `src/durable-objects/auth-state.ts:167-173` (register `user_exists` 409), `:234-239` vs `:244` (login fast-path), `:876-881` (add-member `user_not_found`); route passthrough `src/routes/auth.ts:34,57`.

**Description**: Three enumeration vectors:
1. `POST /api/auth/register` with a victim email returns `409 user_exists` — a public, unauthenticated existence oracle for every registered account.
2. `POST /api/auth/login` returns byte-identical 401 `invalid_credentials` for unknown email vs wrong password (good), but the unknown-email path returns *without* running `crypto.subtle.digest` while the wrong-password path runs it — a repeatable timing differential that distinguishes "no such user" from "wrong password" statistically.
3. `POST /api/projects/:slug/members` returns `404 user_not_found` for non-existent emails (gated behind owner/admin membership, so lower exposure).

**Concrete production exploitation**: An attacker harvesting targets for Finding 3's brute force confirms `ceo@victim.com` has an account via the 409, then focuses guessing; or times logins across a candidate email list to prune it before credential stuffing. On a single-tenant self-hosted tool this mostly leaks "how many/which accounts exist" — reconnaissance value feeding the HIGH findings.

**Remediation**: Return a generic 200-with-generic-error flow for register duplicates if enumeration matters (or keep 409 deliberately — document the tradeoff); make login run the same hash computation for unknown users (hash a dummy value against a fixed salt so both paths cost the same); optionally add jitter. Keep the add-member oracle but rate-limit it.

---

### 5. [MEDIUM] Session tokens stored in plaintext in the database

**File**: `src/durable-objects/auth-state.ts:1056-1067` (`createSession` inserts the raw session ID as the primary key), schema `:15-21`, validation `:277-323` (lookup by raw token).

**Description**: API tokens are stored hashed (`token_hash`, :52,677) — good. Session tokens are not: the `sessions.id` column *is* the bearer token. Anyone with read access to AuthState storage (same threat model as Finding 1's leak) can replay every live session — 30-day full-access bearer tokens for every active user, admin included. Unlike password hashes, there is nothing to crack; the plaintext is directly usable. Logout (`:267-275`) deletes only the single presented session; there is no "revoke all sessions for user X" primitive, so a leak cannot be responded to without DB surgery.

**Concrete production exploitation**: Same leak event as Finding 1, but instead of offline cracking (which strong password hashing would defeat), the attacker immediately hijacks all *active* sessions, including the admin's, regardless of password strength.

**Remediation**: Store `SHA-256(token)` (or HMAC with a per-instance secret) in `sessions.token_hash`, keep a short display prefix if needed, and look up by hash — exactly the pattern already used for `api_tokens`. Add a per-user session-revocation endpoint and wire it into future password-change/admin flows.

---

### 6. [MEDIUM] Plain project members can rewrite project security config and retention (role-check inconsistency)

**File**: `src/routes/projects.ts:207-225` (`maxEventsPerHour` → `http://internal/config/update`, no role check), `:228-246` (`retentionDays` → `http://internal/settings/update`, no role check), `src/routes/filters.ts:69-166` (any member creates/updates/deletes inbound filters). Contrast: `webhookUrl` on the same PATCH correctly requires owner/admin via `auth-state.ts:563-574`.

**Description**: `PATCH /api/projects/:slug` gates the *webhook* field behind owner/admin, but forwards `maxEventsPerHour` and `retentionDays` straight to ProjectState endpoints that receive **no caller identity at all** — so any user with the lowest project role (`member`) can: raise the event rate limit, or set `retentionDays` to delete stored events early / disable retention; likewise any member can create/delete inbound filters that silently drop incoming error events (filters are the "make errors disappear" control). Tests (`test/rate-limiting.test.ts:37-58`, `test/projects.test.ts:367-452`) only exercise this as the owner, so the gap is invisible to CI.

**Concrete production exploitation**: A contractor added as `member` to the payments-service project before offboarding sets `retentionDays=1` (or installs a broad message filter) — the team's error history and alerting decay silently; incident forensics lose data. A disgruntled member sets `maxEventsPerHour` to impair ingestion during an incident.

**Remediation**: Route config/retention/filter mutations through a role check consistent with webhook settings (owner/admin). Pass the requester's role into the ProjectState calls (or resolve authorization in AuthState first) so the DO doesn't accept anonymous config writes; add tests where a plain `member` attempts each mutation and expects 403.

---

### 7. [MEDIUM] Durable Object "internal" API is a zero-auth trust boundary; route checks race (TOCTOU)

**File**: `src/durable-objects/auth-state.ts:821-1030` — `handleListProjectMembers`, `handleAddProjectMember`, `handleRemoveProjectMember`, `handleUpdateProjectMember` take **no requester identity** and perform **no authorization**; `:430-478` `handleGetProject` has an unscoped no-userId branch (currently dead from HTTP); `src/routes/members.ts:14-60` does the check (`get-project` + `check-access`) *before* the mutation call. Same pattern for ProjectState `config/update`/`settings/update` (Finding 6).

**Description**: The architecture places 100% of authorization in the Worker route layer; DO endpoints like `add-project-member` will mutate membership for *any* caller that can reach them. Today that means `routes/members.ts` — which does enforce owner/admin — but:
- **TOCTOU**: the route checks the caller's role, `await`s two DO fetches, then issues the mutation. A concurrently demoted/removed caller's in-flight request still mutates. Window is milliseconds, but it's structural, and the pattern (`check-access` then blind mutation) is copied across member routes.
- **Latency**: any future route, cron, RPC method (`src/rpc.ts` already exposes a service-binding entrypoint), or refactor that forwards these paths inherits full member-management power. The dead `getProject` branch without `userId` (:449-458) is a ready-made slug→project IDOR if ever wired to a route.

**Concrete production exploitation**: Mostly latent today; the practically abusable piece is the TOCTOU (demoted admin races their own removal to add a collaborator) and the future-bug surface. This is defense-in-depth debt with a demonstrated enforcement asymmetry: `handleDeleteProject` *does* re-check owner inside the DO (:521-535) — the member handlers should too.

**Remediation**: Pass `requesterId`/`requesterRole` into every mutating DO handler and re-verify membership/role inside the DO (matching `delete-project`'s existing pattern). Delete the unscoped `get-project` branch. For TOCTOU, a single DO-side check removes the race entirely since the check and INSERT then run in one synchronous SQLite sequence.

---

### 8. [MEDIUM] API tokens are unscoped and never expire by default

**File**: `src/durable-objects/auth-state.ts:631-705` (create — `expiresAt` optional, NULL default, no scope field), `:761-819` (validate — grants full user identity/role); route-layer-only management guard `src/routes/auth.ts:115-128`.

**Description**: A `wst_` token authenticates as its user with *every* privilege except API-token management (that single exception lives in the route layer, not the DO): create/delete the user's projects, manage members if the user is owner/admin, read all issue/event data, change webhook/retention/rate-limit config, and — if the user is the instance admin — call `GET /api/admin/users`. There is no project scoping, no read-only scope, no per-token capability. `expiresAt` is optional and NULL by default → permanent until manually revoked; the fabricated `session.expiresAt` at `:814` is cosmetic, not enforced for NULL-expiry tokens. Entropy itself is good (`wst_` + 64 hex chars, 256 bits from `crypto.getRandomValues`), and at-rest hashing is correct.

**Concrete production exploitation**: A CI token pasted into a third-party service (or leaked from `.env` in a repo) is a permanent, full-account credential. Revocation requires the human to notice; nothing ages out. If the token's owner is the bootstrap admin, the leak also yields the user list.

**Remediation**: Add scopes (e.g. `events:read`, `projects:manage`) enforced in `authMiddleware`/handlers; default expiry (e.g. 90 days) with mandatory maximum; move the "tokens can't manage tokens" rule into the DO handler so it survives refactors; surface `last_used_at` (already tracked, `:794-799`) in the dashboard to aid leak detection.

---

### 9. [LOW] CORS allows any origin with credentials enabled

**File**: `src/index.ts:30-38`.

```ts
cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'], ..., credentials: true })
```

**Description**: `Access-Control-Allow-Origin: *` combined with `credentials: true` is a spec-invalid combination — browsers refuse credentialed cross-origin requests with wildcard ACAO — so today (pure `Authorization`-header bearer auth; no cookies are ever set) the practical impact is limited. The residual risk is that any origin may issue cross-origin API calls with the `Authorization` header: any injected script on any page that can exfiltrate the localStorage token doesn't even need same-origin privileges to use it, and a future switch to cookie sessions would silently turn this config into a real credentialed-CORS hole. The dashboard stores the bearer token in `localStorage` (`packages/dashboard/src/stores/auth.ts:25,62,80`), so any XSS in the SPA is full account compromise regardless of CORS — `*` just removes any residual origin friction.

**Concrete production exploitation**: Not directly exploitable while auth stays header-based; becomes HIGH-impact the day cookie sessions are introduced without touching this line.

**Remediation**: Set an explicit origin allowlist (dashboard origin, configurable via env var); drop `credentials: true` until cookie auth exists. Note: browser-based Sentry SDK ingestion may need permissive CORS on `/api/{projectId}/envelope/` — scope the restrictive config to `/api/auth/*`, `/api/projects/*`, `/api/admin/*` and keep ingestion permissive.

---

### 10. [LOW] No input validation on auth inputs; case-variant duplicate email crashes with SQL error disclosure; 500s leak internals

**File**: `src/routes/auth.ts:12-20` + `src/durable-objects/auth-state.ts:159-164` (no email format / password policy), `:167` vs `:190` (existence check uses raw email, INSERT lowercases it), `:140-149` (fetch catch returns `error.message` to clients).

**Description**: Registering `Alice@x.com` after `alice@x.com` exists passes the raw-email existence SELECT, then violates the UNIQUE constraint on insert at the lowercase — the SqlError is caught only by the generic fetch handler, returning **500 with the raw SQLite error message** to the client. No email format validation anywhere; `name` is stored and echoed unvalidated (stored-XSS surface depends on dashboard rendering — cross-slice, flagged for the frontend analyst).

**Concrete production exploitation**: Fuzzing/monitoring noise plus information disclosure of internal error text; more importantly it's the same normalization bug class as Finding 2's race loser.

**Remediation**: Lowercase email before *all* uses; validate email shape and password length (ties into Finding 3); return generic `500 internal_error` without `error.message` in production paths.

---

### 11. [LOW] No account lifecycle: no password change/reset, no user disable/delete, no session revocation, no admin demotion

**File**: `src/routes/admin.ts:12-35` (admin surface is only `GET /users`), `src/routes/auth.ts` (no password endpoints), `src/durable-objects/auth-state.ts` (no delete/update-user handlers), logout `src/routes/auth.ts:61-81` deletes only the presented token.

**Description**: The prompted scenario "admin reassignment when owner deleted" is moot — *nothing can delete users or change roles at the instance level*. The first user is admin forever; a compromised admin account cannot be locked out (no disable, no revoke-all-sessions); password compromise has no user-driven remediation (no change-password invalidating sessions). This severely blunts incident response for every other finding here.

**Concrete production exploitation**: Not attacker-executed, but guarantees that any successful Finding 1/2/3/5 exploit persists indefinitely — the only remediation is direct Durable Object SQL surgery in production.

**Remediation**: Add admin endpoints: change user role, disable user, force-logout (delete sessions by user_id — `idx_sessions_user` already exists, auth-state.ts:22), password change with global session invalidation; self-service password change; document bootstrap-admin recovery.

---

## Integration test throughlines

These scenarios are **not** covered by the current suite (verified against `test/{auth,api-tokens,admin,projects,members,filters,rate-limiting}.test.ts`) and directly target the findings above. Suite is stateful (`isolatedStorage: false`), so user/project fixtures persist within a describe block.

1. **Bootstrap race → exactly one admin.** Precondition: pristine DB. Fire N=20 parallel `POST /api/auth/register` (distinct emails). Expected: all 200; exactly one user has `role='admin'`; no 500s. (Today: multiple admins / 500s possible — Finding 2.)
2. **Case-insensitive duplicate email.** Register `Admin@X.com`, then `admin@x.com`. Expected: second returns 409 `user_exists`. (Today: 500 with SQL error — Findings 2/10.)
3. **Sequential admin squatting policy.** Register attacker first, then intended owner. Expected per chosen policy: either documented "first user wins" or bootstrap-token gate rejects non-allowlisted first registration. (No test pins the intended behavior — Finding 2.)
4. **Login brute-force throttle.** 50 rapid failed `POST /api/auth/login` for one email, then a correct login. Expected: 429 with `Retry-After` after threshold; correct-password attempt after cooldown succeeds. (Today: unlimited 401s — Finding 3.)
5. **Register password policy.** `POST /api/auth/register` with `password: "a"`. Expected: 400. (Today: 201 — Finding 3/10.)
6. **Login timing parity (best-effort).** Compare median latency of unknown-email vs wrong-password logins over 100 samples each. Expected: statistically indistinguishable. (Today: fast-path skips hashing — Finding 4.)
7. **Member cannot change project security config.** Owner adds user as `member`; member sends `PATCH /api/projects/:slug` with `{"maxEventsPerHour": 0}` and separately `{"retentionDays": 1}`, and `POST /api/projects/:slug/filters` with a catch-all message filter. Expected: 403 on each. (Today: 200/201 — Finding 6.)
8. **API token scope/lifecycle.** Create `wst_` token *without* `expiresAt`; expected: default expiry applied (or suite pins documented never-expires decision). Token then calls `GET /api/admin/users` as an admin's token — pin the intended answer. Token calls `POST /api/auth/tokens` → expect 403 (guard exists at routes/auth.ts:115-128 but has no test).
9. **Session-token storage opaqueness (DO-level).** Directly invoke AuthState `/login`, inspect `sessions` table via storage API. Expected: stored id ≠ returned token (hash at rest). (Today: identical — Finding 5.)
10. **Demoted-member TOCTOU.** Owner demotes member to nothing (`DELETE .../members/:userId`), and the demoted user concurrently re-issues `PATCH .../members/:otherUserId` in-flight. Expected: mutation rejected by DO-side check. (Today: route-only check — Finding 7.)
11. **Unscoped get-project branch.** DO-level: call `/get-project` with `{slug}` only (no userId). Expected: 400/404, never project data. (Today: returns any project — latent Finding 7.)
12. **CORS posture.** `OPTIONS /api/projects` with `Origin: https://evil.example` and `Access-Control-Request-Headers: authorization`. Expected: ACAO is the configured dashboard origin, not `*`; no `Access-Control-Allow-Credentials` while cookie-less. (Today: `*` + credentials — Finding 9.)
13. **Coverage already present — keep green**: logout invalidates token (auth.test.ts:209); expired/revoked API token rejected (api-tokens.test.ts:176,203); cross-user project GET → 404 (projects.test.ts:160); non-owner/non-admin member add rejected (members.test.ts:144); owner removal/role-change blocked (members.test.ts:214,258); non-admin `GET /api/admin/users` → 403 (admin.test.ts:41); cross-user token revoke → 404 (api-tokens.test.ts:110).

## Non-issues / hardening notes

Checked and sound:

- **Middleware coverage is complete.** `app.use('/api/projects/*')` and `/api/admin/*` (index.ts:55,65) — empirically verified with Hono 4.11.3 that the wildcard **does** match the bare `/api/projects` path (the dual `use()` at index.ts:47-48 for tokens is redundant but harmless). Every handler additionally self-checks `c.get('auth')` (all 21 call sites across projects/members/filters/admin/issues/events/releases/sourcemaps). `/api/auth/me` and `/logout` self-check.
- **No slug IDOR at the HTTP surface.** Every `get-project` call passes `userId: auth.user.id` and the DO joins through `project_members` (auth-state.ts:443-448), returning 404 for non-members — status parity avoids existence leaks on project slugs. `GET /api/projects/:slug` cross-user access is tested (projects.test.ts:160).
- **Owner-only project delete is enforced twice** (route membership + DO owner check, auth-state.ts:521-535). Owner cannot be removed or role-changed (auth-state.ts:944-948, 994-998; tested). Roles limited to `admin|member` for non-owners; no self-promotion path exists at the project level (role writes require caller owner/admin — members.ts:98,134,170).
- **Token/session entropy is strong.** `generateKey(64)` → 64 hex chars from CSPRNG (256-bit session ids); DSN keys 128-bit; `crypto.getRandomValues` throughout (auth-state.ts:1094-1101).
- **API tokens: hashed at rest** (uniquely indexed), prefix-only display, max 10/user, revocation ownership-checked (`user_id` in WHERE, auth-state.ts:745-747), expiry enforced on validation, `last_used_at` tracked. The `wst_`-prefix routing (middleware/auth.ts:29) can't collide with hex session ids.
- **Session fixation is N/A**: opaque server-generated tokens; client never supplies a session identifier. Login response parity for unknown-email vs wrong-password *content* is correct (identical 401 bodies).
- **Session expiry enforced in SQL** (`expires_at > now`, auth-state.ts:294) with opportunistic cleanup; validation always joins current `users.role`, so no stale-role sessions.
- **Instance-admin surface is tiny and triple-gated** (middleware + route role check + DO role check on list-users).

Hardening ideas (beyond finding remediations):

- Constant-time comparison in `verifyPassword` (auth-state.ts:1091) — negligible practical risk (hash-vs-hash), but free to fix.
- Per-user session cap / idle timeout; session rotation on privilege-relevant actions.
- Log auth events (register/login success/failure/token create/revoke, member role changes) for audit; currently `console.error` only on exceptions.
- `Authorization`-in-`localStorage` is the dashboard's XSS blast radius (stores/auth.ts:62) — consider HttpOnly-cookie sessions + CSRF tokens someday; if so, fix Finding 9's CORS first.
- Rate-limit `register` and `logout` too (logout currently accepts any token string and runs a DELETE — harmless but unauthenticated-DB-write-shaped).
- Security headers (CSP etc.) on the SPA shell are out of this slice — flagged for the frontend analyst.
- The ingestion DSN public-key model (`get-project-by-key`, used by routes/ingestion.ts:65 and rpc.ts:85) is possession-based authn outside this slice; noted here only because it shares the AuthState trust boundary (Finding 7 applies to it equally).
