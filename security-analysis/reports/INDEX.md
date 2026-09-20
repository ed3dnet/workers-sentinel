# Security Analysis Index

Branch `security-analysis` · 2026-09-19 · 6 analysts (model `zai/glm-5.3(high)`), static analysis only, max 3 concurrent.

## Methodology

Codebase split into 8 slices with deliberate overlap (every slice seen by ≥2 analysts):

| Report | Focus | Slices |
|---|---|---|
| [A1-ingest-storage.md](./A1-ingest-storage.md) | Untrusted input path → storage | ingestion+parser, AuthState DO, ProjectState DO |
| [A2-authn-authz.md](./A2-authn-authz.md) | Authentication & authorization | auth routes/middleware/admin, AuthState DO, projects/members/filters |
| [A3-data-exposure.md](./A3-data-exposure.md) | Data exposure & outbound | ProjectState DO reads, issues/events/releases/sourcemaps, webhooks/RPC/wiring |
| [A4-perimeter.md](./A4-perimeter.md) | Perimeter | ingestion, auth headers, CORS/wiring/config, dashboard client |
| [A5-tenant-isolation.md](./A5-tenant-isolation.md) | Multi-tenant isolation | ProjectState DO, projects/members, issues/events |
| [A6-fullstack-exposure.md](./A6-fullstack-exposure.md) | Full-stack exposure | AuthState user data, events→UI APIs, dashboard rendering |

Raw totals (cross-agent duplicates included): **1 CRITICAL · 10 HIGH · 25 MEDIUM · 22 LOW · 14 INFO** across 72 findings.

## Corroborated throughlines (multiple independent analysts — highest confidence)

1. **Unsalted single-pass SHA-256 password/token hashing** — A2#1 [CRITICAL], A6 H-1 [HIGH], A1 I-2, A5 F7 (also for user identifiers), A4-02 (paired with unthrottled login). *5 agents.* Fast offline cracking on DB disclosure; identical passwords share hashes; non-constant-time verification.
2. **CORS `origin:'*'` + `credentials:true` on all `/api/*`** — A4-01 [HIGH], A6 M-2, A2#9, A1 L-3, A3#8. *5 agents.* Any origin reads API responses (cross-origin brute-force/enumeration); credentials flag is dead-but-dangerous.
3. **Member role gap on project security config** — A5 F1 [HIGH], A6 M-1, A2#6. *3 agents.* Any plain `member` can set `retentionDays`/`maxEventsPerHour` (mass event deletion, rate-limit tampering) while only `webhookUrl` is owner/admin-gated.
4. **Raw event payloads (headers/cookies/env/PII/secrets) stored and served unredacted** — A3#1 [HIGH], A6 M-4 (notes `/security` advertises scrubbing that doesn't exist), A1 M-4. *3 agents.*
5. **Unbounded ingestion / cost-DoS family** — A1 H-1/H-2 [HIGH] (rate limit + retention off by default; AuthState singleton bottleneck), A4-03 (body + gzip decompression bomb), A1 M-2/M-3 (no size/cardinality caps), A3#6/#7 (sourcemap quota, unbounded merge array). Cluster across *3 agents*.
6. **Unthrottled auth surface + open registration + racy first-user-admin bootstrap** — A2#2/#3 [HIGH], A4-02/A4-06, A6 M-3. *3 agents.*
7. **Session/API-token model blast radius** — A2#5/#8/#11 (plaintext at rest, unscoped, no expiry/revocation/lifecycle), A4-04 (localStorage, no CSP backstop), A6 M-3 (30-day non-rotating). *3 agents.*
8. **Project deletion never purges the ProjectState DO** — A3#2 [HIGH], A5 F3. *2 agents.* All tenant data survives "deletion" indefinitely; no purge path exists.
9. **No browser hardening headers/CSP** — A4-05, A3#10. *2 agents.*
10. **LIKE wildcard injection in issue search** — A1 L-4, A3#9, A6 I-2 (tag-values escapes correctly; search doesn't). *3 agents.*
11. **DSN key in query param / logs / telemetry** — A4-07, A1 I-4 (+A4-10 unauthenticated `/security` stub). *2 agents.*
12. **Negative `limit` pagination bypass** — A3#3 [MEDIUM] (`?limit=-1` → SQLite unlimited → one-request full dump). Single agent but mechanically verified.
13. **DO `http://internal/*` zero-auth trust boundary + TOCTOU** — A2#7. Single agent; structural (route-level checks race DO handlers).

## Verified negatives (hold these lines during remediation)

- **No cross-tenant read/write break** (A5, exhaustive route sweep): every `/api/projects/*` route does slug+userId membership JOIN; ProjectState DO always resolved via `idFromName(<server UUID>)` after that check; ingestion/RPC additionally reject URL-ID/DSN mismatch.
- **No stored-XSS sink in the dashboard** (A6 I-1): all attacker event content reaches Vue via escaped interpolation; sourcemap resolver is pure parsing (no eval/`sourceURL`).
- **No SQL injection or prototype-pollution sinks on the ingest path** (A1); DSN key→project binding sound (128-bit CSPRNG, UNIQUE, URL/key match enforced).
- Slug lifecycle uniqueness sound (A5 F8).

## Remediation priority (cross-cutting order; per-finding detail in reports)

- **P0** — (1) password hashing → PBKDF2/scrypt via WebCrypto (+ migration path for existing hashes); (2) CORS: pin origins, drop `credentials:true` or pair with allowlist; (3) auth throttling/lockout + registration control + fix admin bootstrap race.
- **P1** — role-gate `retentionDays`/`maxEventsPerHour` (and all security config) to owner/admin; purge ProjectState DO on project deletion; clamp pagination `limit` (reject negatives); ingestion caps (body/decompressed size, per-field length, tag/user/release cardinality, default-on rate limit + retention).
- **P2** — hashed session/API tokens at rest + expiry + revocation + scoping; webhook SSRF hardening (block redirects/private hosts, timeouts, cap response, don't echo target responses); payload redaction/scrubbing (make `/security` real); security headers + CSP + `_headers`; member lifecycle (password change/reset, session revocation, admin demotion, audit trail); LIKE escaping; merge/sourcemap bounds.

## Integration test throughlines

Per-report sections with concrete method+path+precondition+expected scenarios: A2 (13), A3 (10), A5 (12), A6 (10), plus A1/A4 sections. Highest-leverage suites to build first: cross-tenant read/write sweep per route (A5), role regression for the retention/filter config gap (A5 F1/F2, A6 M-1), pagination bound clamping (A3#3), ingestion cap fuzzing (A1/A4-03), CORS preflight matrix (A4-01), and admin-bootstrap race (A2#2).
