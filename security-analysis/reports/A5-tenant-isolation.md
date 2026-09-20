# A5 — Tenant Isolation

## Summary

**Scope.** Multi-tenant isolation review of workers-sentinel (Cloudflare Worker + two SQLite-backed Durable Objects):

- `packages/workers-sentinel/src/durable-objects/project-state.ts` — per-project DO: identity derivation, internal endpoint surface, per-project config/settings/filters/sourcemaps handlers.
- `packages/workers-sentinel/src/routes/projects.ts`, `members.ts`, `filters.ts` — project lifecycle, membership, role model.
- `packages/workers-sentinel/src/routes/issues.ts`, `events.ts`, `releases.ts`, `sourcemaps.ts` — per-project data APIs.
- Supporting evidence read: `src/index.ts` (route mounting/auth middleware), `src/middleware/auth.ts`, `src/durable-objects/auth-state.ts` (slug/membership/role/token handlers), `src/routes/ingestion.ts`, `src/rpc.ts`, `src/lib/webhook.ts`, and `test/*.test.ts` (18 files) for coverage evidence.

**Method.** Static analysis only. Attacker model: an authenticated low-privilege user (project role `member`, or instance role `member`) who is a member — or a non-member — of one project, targeting another tenant's project. Every `/api/projects/*` route's authorization path was compared; DO namespace derivation (`idFromName` inputs) was traced on every path that reaches `PROJECT_STATE`; role checks on destructive operations were compared across routes; slug generation/uniqueness, invite flow, IDOR scoping, error-message oracles, and cross-project side channels (stats, webhooks, rate-limit state) were each examined. Test files were read to distinguish covered from uncovered behavior.

**Confidence.** High for the core isolation verdict (every route was read line-by-line; all `get-project` call sites were grepped and verified). Medium-high for the role-enforcement findings (code paths are unambiguous, but "intended" policy is inferred from the checks that do exist elsewhere — e.g. `webhookUrl` is owner/admin-gated while `retentionDays` on the same endpoint is not). The runtime was not exercised (no dynamic testing), per instructions.

**Headline verdict.** No cross-tenant read/write break was found. The single gate — `AuthState.handleGetProject` with `slug + userId` membership JOIN returning 404 — is applied consistently on every project-scoped route, and the ProjectState DO is always addressed as `idFromName(<server-resolved project UUID>)`, never from raw user input. The real weaknesses are *role-model* gaps inside a tenant (a `member` can destroy project data via retention/rate-limit config and silently suppress ingestion via filters), orphaned DO data after project deletion, and route-only (not DO-enforced) authorization for member management.

---

## Findings

### F1 — [HIGH] Any `member` can rewrite retention and rate-limit config (destructive), while the same PATCH field requires owner/admin

**File:line.** `packages/workers-sentinel/src/routes/projects.ts:206-246` (forwards `maxEventsPerHour` / `retentionDays` with membership-only check); contrast `packages/workers-sentinel/src/durable-objects/auth-state.ts:567-574` (`webhookUrl` requires owner/admin); `packages/workers-sentinel/src/durable-objects/project-state.ts:1687-1699` and `1775-1801` (DO handlers have no authorization concept at all).

**Description.** `PATCH /api/projects/:slug` performs one membership check (`get-project` with `userId` → 404 for non-members), then fans the body out to three different backends with divergent authorization:

- `webhookUrl` → `AuthState /update-project`, which re-checks role **owner/admin** (403 otherwise).
- `maxEventsPerHour` → `ProjectState /config/update` — **no role check anywhere**.
- `retentionDays` → `ProjectState /settings/update` — **no role check anywhere**.

The ProjectState DO cannot check roles (it has no membership knowledge), and the route does not call `check-access` before forwarding. The system's own design elsewhere states these are settings: `GET /:slug/settings` and the rate-limit status page are admin-facing dashboard pages, and the webhook setting on the same endpoint is owner/admin-gated.

**Concrete production exploitation.** Attacker is a `member` (lowest role) on `acme-checkout`, added years ago for triage. One authenticated request:

```
PATCH /api/projects/acme-checkout
{"retentionDays": 1, "maxEventsPerHour": 1}
```

→ 200 OK. Within one alarm cycle the retention job (`project-state.ts:1726-1759`) deletes every event, `issue_stats` bucket, `issue_users` row, and every issue whose count reaches 0 — the project's entire error history, including the forensic record of the attacker's own earlier misdeeds in that project. Additionally, `maxEventsPerHour: 1` makes the next real SDK event trip the rate limit for the rest of the hour (`checkRateLimit`, `project-state.ts:1638-1664`), so production error reporting for the whole tenant silently degrades (ingestion returns 429). Alternatively `maxEventsPerHour: 0` disables the limit an owner configured as a cost control. Nothing is audited (no activity-log entry is written for config changes).

**Remediation.** Enforce owner/admin for `maxEventsPerHour` and `retentionDays` on the route (reuse the `getProjectAndRole` helper from `members.ts`), or better: make `AuthState.handleUpdateProject` the single chokepoint for *all* project settings by having it verify role first and only then instruct the worker to push config into ProjectState. Add an `issue_activity` entry for settings changes so destructive config edits are attributable.

---

### F2 — [MEDIUM] Inbound filters are writable by any `member` — silent, targeted event suppression

**File:line.** `packages/workers-sentinel/src/routes/filters.ts:69-166` (all three write routes call only `getProjectWithAccess`); `packages/workers-sentinel/src/durable-objects/project-state.ts:1447-1566` (DO handlers accept any caller); `project-state.ts:1396-1439` (`shouldFilterEvent` drops matching events during ingest).

**Description.** `POST/PATCH/DELETE /api/projects/:slug/filters` require membership but no role. Filters are applied at ingest time and silently drop matching events (counted in `dropped_count`, visible only to people who open the filter list). A `member` can create a filter that matches broad patterns, disable the owner's existing filters, or delete them.

**Concrete production exploitation.** Attacker (member of `acme-checkout`) creates a filter `{"filterType": "error", "pattern": ".*PaymentFailed.*"}` or a pattern matching the payment service's release. All future events matching it are dropped before grouping — the team's monitoring goes blind exactly where the attacker is about to act (or where a real incident is developing), with no dashboard error and no notification. This is a low-noise way to blind a tenant's observability from the lowest privilege level.

**Remediation.** Gate filter create/update/delete on owner/admin, consistent with webhook management. (Read access for members is fine.)

---

### F3 — [MEDIUM] Deleting a project never purges its ProjectState Durable Object — tenant data survives "deletion"

**File:line.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:514-541` (`handleDeleteProject` deletes only `projects` + cascaded `project_members`); no corresponding call in `packages/workers-sentinel/src/routes/projects.ts:348-389` to any purge endpoint — none exists in `project-state.ts`'s router (`project-state.ts:228-306`).

**Description.** Project deletion removes the registry rows but the per-project DO — containing issues, full event payloads (stack traces, request URLs, headers, user tags, breadcrumbs), `issue_users` hashes, source maps (potentially full production source code), comments, and activity — keeps its SQLite storage forever, and its alarm loop (`scheduleNextAlarm`, `project-state.ts:1320-1345`) keeps rescheduling if snoozes/retention were configured.

**Concrete production exploitation.** A tenant offboards: owner deletes the project believing the data is gone (self-hosted GDPR/retention posture). The event data — including end users' emails/IP-derived hashes and full stack traces — remains in DO storage indefinitely. It is not reachable through today's API (the slug/UUID no longer resolves), but it is one future bug away from exposure: any code path that ever addresses `PROJECT_STATE.idFromName(<old project UUID>)` (e.g. a re-introduced ingestion path keyed by ID, a restore feature, an admin tool) would serve it back. It also silently inflates storage cost and keeps alarms billing.

**Remediation.** On `delete-project`, have the worker call a new `/reset` endpoint on the ProjectState DO that drops all tables and cancels the alarm (idempotent), before removing registry rows. Consider a periodic janitor that lists project IDs from AuthState and GCs DOs that no longer resolve.

---

### F4 — [MEDIUM] Member-management authorization is route-only, and admins can act against other admins

**File:line.** `packages/workers-sentinel/src/routes/members.ts:89-190` (role check `owner||admin` lives only in the route); `packages/workers-sentinel/src/durable-objects/auth-state.ts:850-1030` (`handleAddProjectMember`, `handleRemoveProjectMember`, `handleUpdateProjectMember` perform **no caller authorization** — they only protect the owner row from removal/demotion).

**Description.** Two distinct weaknesses in the same flow:

1. **Defense-in-depth gap.** The DO endpoints mutate `project_members` with zero caller verification. Today every caller is the route with its role check, but the pattern is fragile: compare `handleUpdateProject`/`handleDeleteProject`, which *do* re-verify the caller's role inside the DO. A future RPC/admin path that calls `add-project-member` directly inherits an authz bypass. (Contrast with F1, where the missing half of this pair is the route check.)
2. **Admin vs admin.** Any `admin` can add users directly **as admin**, demote another admin to `member`, or remove another admin entirely (`members.ts:98,134,170` treat owner and admin identically). A single compromised admin account can lock out every other operator (except the owner) before the owner notices.

**Concrete production exploitation.** Attacker holds the `admin` role on a shared project (or compromised an admin's session token). Sequence: add a fresh account as `admin`; remove/demote the two other admins; the project now has owner + attacker-controlled admins only. If the owner is on vacation, the attacker has unmonitored control of webhooks (exfil channel), retention, and filters. No activity trail exists for membership changes.

**Remediation.** Move the caller-role check into the AuthState handlers (accept `callerId`, verify owner/admin server-side, mirroring `handleUpdateProject`). Decide a policy for admin-vs-admin operations — owner-only for demoting/removing admins is the safer default — and log all membership mutations to `issue_activity` or an audit table.

---

### F5 — [LOW] Email existence oracle via member-add (and registration)

**File:line.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:872-881` (404 `user_not_found` vs 409 `already_member`); `auth-state.ts:166-173` (public 409 `user_exists` on register).

**Description.** `POST /api/projects/:slug/members` distinguishes "no such user" (404) from "already a member" (409). Any project owner/admin can probe arbitrary emails to learn who has an account on the instance (username enumeration for the login page). The public register endpoint already discloses existence (409), so this adds little new exposure, but it extends the oracle to project-level admins who are not instance admins.

**Concrete production exploitation.** A contractor with admin on one project confirms that `ceo@acme.example` has an account before launching a credential-stuffing/password-spray campaign against `/api/auth/login` (login correctly returns a uniform `invalid_credentials`).

**Remediation.** Return a generic response for not-found vs already-member (or an "invite queued" 200) and rely on email notification; consider the same for registration if enumeration matters for this deployment.

---

### F6 — [LOW] `handleGetProject` has a latent no-userId branch that skips the membership JOIN

**File:line.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:449-458`.

**Description.** When called without `userId`, `get-project` resolves the slug with **no membership filter**. Today every caller (grep-verified across `projects.ts`, `members.ts`, `issues.ts`, `events.ts`, `releases.ts`, `sourcemaps.ts`, `filters.ts`) passes `auth.user.id`, so the branch is dead code. But `get-project` is the system's single tenant gate; a single future call site that forgets `userId` turns it into a full cross-tenant read primitive for every downstream route, silently and with no error.

**Concrete production exploitation.** None today (dead branch). This is a loaded footgun, not a live vuln.

**Remediation.** Delete the else-branch and return 400 when `userId` is missing (fail closed), or make the SQL always require the JOIN.

---

### F7 — [LOW] End-user identifiers hashed with unsalted SHA-256 — cross-project linkable and reversible for low-entropy inputs

**File:line.** `packages/workers-sentinel/src/durable-objects/project-state.ts:1586-1600` (`hashUserIdentifier`).

**Description.** `user.id || user.email || user.ip_address || user.username` is hashed with plain SHA-256 (no salt, no key) and truncated to 32 hex chars, stored as `issue_users.user_hash`. Because the hash is deterministic and unkeyed, the same end user produces the **identical** hash in every project's DO. The API never returns raw hashes (only `COUNT(DISTINCT user_hash)` aggregates — verified), so this is not directly exploitable through the dashboard; the risk is (a) cross-tenant user correlation if a DO storage dump or a future API ever exposes hashes, and (b) trivial reversal of low-entropy identifiers (emails, IPs) by dictionary attack.

**Concrete production exploitation.** Requires a secondary exposure (storage access or future API surface). Given one, an operator of project A who is also member of project B can hash a known email offline and confirm the same person appears in B's user counts — or reverse B's hashes wholesale for emails/IPs.

**Remediation.** Use `HMAC-SHA256` keyed with an instance-wide secret (env var) instead of bare SHA-256. Intra-project dedup still works; cross-project and cross-instance linkability disappears.

---

### F8 — [INFO] Slug lifecycle: uniqueness is sound; all-unicode names produce an empty slug

**File:line.** `packages/workers-sentinel/src/durable-objects/auth-state.ts:1103-1109` (`slugify`), `349-356` (collision loop), schema `auth-state.ts:28` (`slug TEXT UNIQUE NOT NULL`).

**Description.** `slugify` lowercases, strips everything outside `[a-z0-9]`, collapses runs, trims hyphens, caps at 50 chars. Combined with the global `UNIQUE` column, a counter-suffix loop, and the fact that AuthState is a **singleton DO** (creation requests serialize; no TOCTOU), slug collisions across tenants are handled correctly. Case and unicode homoglyphs cannot collide because both are normalized away (`Café` and `cafe` → `caf`; `СА` Cyrillic → `-` …) — two visually identical names yield the same slug and the second gets `-1`, which is safe. There is no rename flow (`PATCH /:slug` never touches `name`/`slug`), so "slug regeneration on rename" is currently out of scope. One robustness edge: a name of only non-ASCII characters (e.g. `日本語`) slugifies to the empty string; the first such project is stored with `slug=''` (unroutable via `/api/projects/:slug` — the dashboard project is created but unusable), the next gets `'-1'`. Not a security issue; worth a guard.

**Remediation (robustness).** If `slugify(name) === ''`, fall back to `project-<random suffix>`.

---

### F9 — [INFO] Cross-slice observations flagged for other analysts

1. **Passwords and API tokens hashed with unsalted SHA-256** — `auth-state.ts:1081-1092` (`hashPassword` = single SHA-256, no salt, no KDF). Offline-crackable password DB if AuthState storage leaks. Belongs to the auth slice; noted here because it gates every tenant boundary. Recommend PBKDF2/scrypt/Argon2 via WebCrypto (`crypto.subtle.deriveBits` PBKDF2 is available in Workers).
2. **CORS `origin: '*'` with `credentials: true`** — `src/index.ts:30-38`. Bearer tokens are not auto-sent cross-origin, so impact is limited, but a locked-down deployment should echo an allowlist. Belongs to the transport slice.
3. **API tokens are user-scoped, not project-scoped** — `auth-state.ts:631-819`: a `wst_` token authenticates as the user with full access to *every* project that user can access. A token minted for one project's CI pipeline also carries the user's rights on all their other tenants. Consider per-project scoping (Sentry's model) as product hardening.

---

## Integration test throughlines

The existing suite covers: unauthenticated 401s broadly, non-member GET `/api/projects/:slug` → 404, non-member PATCH `webhookUrl` → 404 (`projects.test.ts:313`), member-role cannot add members → 403 (`members.test.ts:144`), invalid DSN key → 401, and token-revocation ownership (`api-tokens.test.ts:110`). The scenarios below are **not** covered and matter for tenant isolation. Preconditions shorthand: `U1` = authenticated user/token owning project `P-victim` (slug `victim`); `U2` = second authenticated user with no membership; `U3` = user with role `member` on `P-victim`.

1. **Cross-tenant read sweep (per-route).** For each of `GET /api/projects/victim/issues`, `/events/latest`, `/sourcemaps`, `/filters`, `/releases`, `/stats`, `/summary`, `/tags`, `/members`, `/rate-limit`, `/settings`: with U2's token, expect **404 `project_not_found`** and a body containing no victim data. (Only the bare `GET /api/projects/:slug` variant is tested today; the data routes share a copy-pasted gate that a refactor could silently drop.)
2. **Cross-tenant write sweep.** With U2's token: `DELETE /api/projects/victim`, `POST /api/projects/victim/filters`, `PATCH /api/projects/victim` (any field), `POST /api/projects/victim/sourcemaps`, `POST /api/projects/victim/members`, `PATCH /api/projects/victim/members/<U1>` — all must be **404**, never 2xx/403 (403 would confirm existence).
3. **Role enforcement on settings (regression for F1).** U3 (`member`) sends `PATCH /api/projects/victim {"retentionDays":1}` and `{"maxEventsPerHour":1}` → expect **403** (today: 200 — this test documents the fix). Then verify `GET /api/projects/victim/settings` still returns the owner's value. Also assert owner's `webhookUrl` PATCH stays 200 and member's `webhookUrl` PATCH is 403 (the existing asymmetry, now intentional and pinned).
4. **Filter suppression requires elevated role (regression for F2).** U3 sends `POST /api/projects/victim/filters` → expect **403**; then ingest an event matching an owner-created enabled filter and assert it does **not** appear in `GET /issues` (positive path for `shouldFilterEvent`).
5. **Cross-DO IDOR.** Capture an `issueId`/`eventId` from `P-victim`; with U2's token (member of own project `P-own`) request `GET /api/projects/own/issues/<victimIssueId>` and `GET /api/projects/own/events/<victimEventId>` → expect **404 `issue_not_found`** (IDs must not resolve outside their DO).
6. **DSN-to-project binding.** With U2 owning `P-own` (valid DSN) and knowing/guessing `P-victim`'s project UUID: `POST /api/<victimProjectId>/envelope/?sentry_key=<ownKey>` → expect **400 `project_mismatch`** and victim's event count (`GET /victim/stats` as U1) unchanged. Repeat via the RPC entrypoint contract (`captureEnvelope` with mismatched DSN path) at the service-binding level if testable.
7. **Slug collision across tenants.** U1 and U2 each create a project named `Payments` → distinct slugs (`payments`, `payments-1`); U2 requests `GET /api/projects/payments` (U1's slug) → **404**; U1 requests `GET /api/projects/payments-1` → **404**. Include a unicode-only name (`テスト`) asserting a non-empty, routable slug (currently fails — F8).
8. **Membership revocation is immediate.** Remove U3 from `P-victim`; U3's session token then gets `GET /api/projects/victim/issues` → **404** (sessions must not cache membership). Repeat with a `wst_` API token minted by U3.
9. **Owner protection under admin pressure (F4).** With an `admin` U4: `DELETE /api/projects/victim/members/<ownerId>` → **400 `cannot_remove_owner`**; `PATCH .../members/<ownerId> {"role":"member"}` → **400 `cannot_modify_owner`** (both covered today — keep). New: `PATCH .../members/<otherAdminId> {"role":"member"}` and `DELETE .../members/<otherAdminId>` → decide and pin the intended policy (currently 200).
10. **Deleted-project data non-reachability (F3, white-box).** After `DELETE /api/projects/victim`: U1 recreating a project must get a fresh UUID; ingestion with the old DSN → **401**; and (once purge lands) a direct DO-level assertion that the old ProjectState storage is empty.
11. **Instance-admin ≠ project access.** A user with instance role `admin` (first registered user) who is not a member of `P-victim`: `GET /api/projects/victim/issues` → **404**; `GET /api/admin/users` → 200 (only place their role matters). Pins the separation of instance admin from tenancy.
12. **Non-member enumeration hygiene.** U2 requests `GET /api/projects/<random-unknown-slug>` and `GET /api/projects/victim` → both **404 with identical body** (no existence oracle for non-members).

---

## Non-issues / hardening notes

**Checked and sound:**

- **DO namespace derivation.** Every path to `PROJECT_STATE` uses `idFromName(project.id)` where `project.id` is a server-generated `crypto.randomUUID()` read from AuthState's DB after an authorization check — never a raw URL segment, slug, or name. `idFromName` on distinct UUIDs cannot collide. Ingestion (`ingestion.ts:64-82`) and RPC (`rpc.ts:84-102`) resolve the project by the 32-byte random DSN public key first and additionally reject URL/path-ID mismatch (`project_mismatch`), so cross-tenant event injection requires the victim's full DSN key.
- **Per-route membership gate.** All five data-route modules use an identical `getProjectWithAccess` helper: `get-project` with `slug + userId`, which SQL-JOINs `project_members` and returns a uniform 404 — non-member and non-existent projects are indistinguishable on these routes (no existence oracle; no id-vs-slug divergence — no route accepts a project ID in the URL at all for dashboard APIs).
- **IDOR scoping.** Issue/event/release/sourcemap/filter/comment IDs are only meaningful inside one project's DO; all lookups execute inside the caller's own DO, so foreign IDs 404. Event/issue list SQL is fully parameterized with an allowlisted sort field (`ALLOWED_SORT_FIELDS`, `project-state.ts:594,617`).
- **Destructive op checks that do exist.** Project delete is owner-only and enforced *inside* the DO (`auth-state.ts:530`); webhook update is owner/admin inside the DO; owner row is protected from removal and demotion; comment deletion is author-checked inside the DO (`project-state.ts:1262-1264`); API-token revocation verifies ownership (`auth-state.ts:744-754`).
- **Cross-project side channels.** Rate-limit counters, stats, webhook config, filters, and settings all live in the per-project DO — no shared state across tenants found. Webhook payloads (`lib/webhook.ts`) carry project name/slug and issue title/culprit only; webhook URL is HTTPS-validated.
- **Slug uniqueness.** `UNIQUE` column + counter loop + singleton-DO serialization = race-free; case/unicode normalization prevents homoglyph and case-collision attacks (see F8 for the empty-slug edge).
- **Instance-admin separation.** The instance `admin` role unlocks only `/api/admin/users` (route + DO both check); it grants no project access.
- **Auth coverage of mounting.** `app.use('/api/projects/*', authMiddleware)` precedes all `/api/projects` subrouter mounts; ingestion is deliberately outside it (DSN auth) and every project handler independently re-checks `c.get('auth')`.

**Defense-in-depth recommendations (beyond finding remediations):**

1. **Centralize authorization in middleware.** Replace five copies of `getProjectWithAccess` with a Hono middleware that resolves the slug once, loads `{project, role}` into the context, and exposes `requireRole('admin')`. This eliminates the copy-paste drift that F1/F2 exemplify and shrinks F6's blast radius.
2. **Fail closed in DOs.** Pass the caller's role into ProjectState mutations (or at least a boolean "is elevated") so the DO can enforce its own policy, as AuthState already does for delete/webhook.
3. **Audit trail.** Write `issue_activity` entries for membership changes, settings changes, filter changes, merges, and bulk deletes — currently none of these are attributable (only comments and snoozes are).
4. **Keyed user hashing** (F7) and a real password KDF (F9.1).
5. **Restrict CORS** to the dashboard origin(s) rather than `*` (F9.2).
6. **Project-scoped API tokens** (F9.3) for CI/automation use cases.
7. **Remove or guard the no-userId branch** of `get-project` (F6) and the `'/check-access'`-less config path; add a lint/arch test asserting every new `/api/projects/*` route calls the shared gate.
