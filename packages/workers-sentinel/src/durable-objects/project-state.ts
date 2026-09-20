import { DurableObject } from 'cloudflare:workers';
import { createAttachmentStore, migrationKey, projectPrefix } from '../lib/attachment-store';
import { sanitizeEvent } from '../lib/envelope-parser';
import {
	extractCulprit,
	extractMetadata,
	extractTitle,
	generateFingerprint,
} from '../lib/fingerprint';
import type {
	DroppedAttachment,
	Env,
	ExtractedAttachment,
	FilterType,
	InboundFilter,
	Issue,
	ProjectSettings,
	SentryEvent,
} from '../types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** GC alarm cadence floor: an alarm is always scheduled within an hour. */
const ALARM_INTERVAL_MS = 60 * 60 * 1000;
/** Orphaned blobs younger than this are never GC'd (in-flight protection). */
const GC_GRACE_MS = 60 * 60 * 1000;
/** Per-alarm GC bounds: whichever comes first. */
const GC_MAX_OBJECTS = 10_000;
const GC_TIME_BUDGET_MS = 30_000;
/** Inline→R2 migration batch size per alarm run. */
const MIGRATION_BATCH = 100;
/** Purge sweep retry delay when the sweep cannot complete in one run. */
const PURGE_RETRY_MS = 60 * 1000;

/** Per-project attachment payload budget across all stored rows (R2 bytes). */
export const MAX_PROJECT_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Clamp a client-supplied page limit. Negative or non-numeric values fall
 * back to the default: SQLite treats a negative LIMIT as unlimited, so
 * `?limit=-1` must never reach a query.
 */
export function clampLimit(raw: number | undefined | null, fallback: number, max = 100): number {
	if (raw === undefined || raw === null || !Number.isFinite(raw) || raw < 1) return fallback;
	return Math.min(Math.floor(raw), max);
}

/** Headers scrubbed from stored events unless a project overrides the list. */
const DEFAULT_SCRUB_HEADERS = [
	'authorization',
	'proxy-authorization',
	'cookie',
	'set-cookie',
	'x-api-key',
	'x-auth-token',
	'x-session-token',
	'x-csrf-token',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  culprit TEXT,
  level TEXT NOT NULL DEFAULT 'error',
  platform TEXT NOT NULL DEFAULT 'javascript',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  user_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unresolved',
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_issues_fingerprint ON issues(fingerprint);
CREATE INDEX IF NOT EXISTS idx_issues_last_seen ON issues(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'error',
  platform TEXT,
  environment TEXT,
  release TEXT,
  transaction_name TEXT,
  user_id TEXT,
  user_email TEXT,
  user_ip TEXT,
  tags TEXT,
  data TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_environment ON events(environment);
CREATE INDEX IF NOT EXISTS idx_events_release ON events(release);

CREATE TABLE IF NOT EXISTS issue_stats (
  issue_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, bucket),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_users (
  issue_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (issue_id, user_hash),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_tags (
  event_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (event_id, key),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_event_tags_key_value ON event_tags(key, value);
CREATE INDEX IF NOT EXISTS idx_event_tags_issue ON event_tags(issue_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  r2_key TEXT,
  storage TEXT NOT NULL DEFAULT 'inline',
  CHECK (length(filename) <= 200),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_event ON attachments(event_id);

CREATE TABLE IF NOT EXISTS attachment_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_environments (
  issue_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (issue_id, environment),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(issue_id);

CREATE TABLE IF NOT EXISTS issue_activity (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_issue ON issue_activity(issue_id);

CREATE TABLE IF NOT EXISTS releases (
  version TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  new_issue_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_releases_last_seen ON releases(last_seen DESC);

CREATE TABLE IF NOT EXISTS release_issues (
  release_version TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  first_seen_in_release TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (release_version, issue_id),
  FOREIGN KEY (release_version) REFERENCES releases(version) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_release_issues_issue_id ON release_issues(issue_id);

CREATE TABLE IF NOT EXISTS source_maps (
  id TEXT PRIMARY KEY,
  release TEXT NOT NULL,
  file_url TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  UNIQUE(release, file_url)
);
CREATE INDEX IF NOT EXISTS idx_source_maps_release ON source_maps(release);
CREATE TABLE IF NOT EXISTS inbound_filters (
  id TEXT PRIMARY KEY,
  filter_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprint_redirects (
  fingerprint TEXT PRIMARY KEY,
  target_issue_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (target_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
`;

const MIGRATIONS = [
	'ALTER TABLE issues ADD COLUMN snoozed_until TEXT;',
	`CREATE TABLE IF NOT EXISTS fingerprint_redirects (
  fingerprint TEXT PRIMARY KEY,
  target_issue_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (target_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);`,
	// Attachment payloads move to R2: ADD COLUMN only (no table rebuild, no
	// data movement). `data` keeps NOT NULL with '' as the R2-row sentinel;
	// pre-upgrade inline rows keep their payload until the alarm migrates
	// them to deterministic `m/{attachmentId}` keys.
	'ALTER TABLE attachments ADD COLUMN r2_key TEXT;',
	"ALTER TABLE attachments ADD COLUMN storage TEXT NOT NULL DEFAULT 'inline';",
	'CREATE INDEX IF NOT EXISTS idx_attachments_r2_key ON attachments(r2_key);',
	`CREATE TABLE IF NOT EXISTS attachment_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL DEFAULT 0
);`,
];

/** Terminal states of the transactional ingest sequence. */
type IngestOutcome =
	| { kind: 'duplicate' }
	| { kind: 'filtered' }
	| { kind: 'rate_limited' }
	| { kind: 'purge_pending' }
	| {
			kind: 'stored';
			issueId: string;
			isNewIssue: boolean;
			title?: string;
			level: string;
			culprit: string | null;
	  };

export class ProjectState extends DurableObject<Env> {
	private sql: SqlStorage;
	private initialized = false;
	private rateLimitCount = 0;
	private rateLimitBucket = '';

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	private async ensureSchema(): Promise<void> {
		if (this.initialized) return;
		this.sql.exec(SCHEMA);
		for (const migration of MIGRATIONS) {
			try {
				this.sql.exec(migration);
			} catch {
				// Migration already applied — safe to ignore
			}
		}
		// Indexes on migration-added columns are created AFTER the migrations:
		// on a pre-upgrade DO the column does not exist until the ALTER runs,
		// and a CREATE INDEX inside SCHEMA would throw (SCHEMA runs first).
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_issues_snoozed_until ON issues(snoozed_until)');
		this.sql.exec('CREATE INDEX IF NOT EXISTS idx_attachments_r2_key ON attachments(r2_key)');
		this.warmRateLimitCounter();
		this.initialized = true;
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureSchema();

		// Alarm liveness guarantee, independent of isolate warmth: a fired
		// alarm that failed (and exhausted its retries) can leave nothing
		// scheduled — or worse, a wedged overdue timestamp that the runtime
		// never delivers — and ensureSchema early-returns on warm isolates.
		// Re-arm whenever no FUTURE alarm exists, so GC/migration/purge-retry
		// coverage survives both states. (Cheap: one getAlarm storage read;
		// scheduleNextAlarm never delays a future alarm.)
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm <= Date.now()) {
			await this.scheduleNextAlarm();
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			switch (path) {
				case '/ingest':
					return this.handleIngest(request);
				case '/ingest-with-attachments':
					return this.handleIngestWithAttachments(request);
				case '/touch':
					return this.handleTouch(request);
				case '/issues':
					return this.handleGetIssues(request);
				case '/issue':
					return this.handleGetIssue(request);
				case '/issue/update':
					return this.handleUpdateIssue(request);
				case '/issue/delete':
					return this.handleDeleteIssue(request);
				case '/issues/bulk-update':
					return this.handleBulkUpdateIssues(request);
				case '/issue/events':
					return this.handleGetIssueEvents(request);
				case '/event':
					return this.handleGetEvent(request);
				case '/event/attachments':
					return this.handleListEventAttachments(request);
				case '/attachment':
					return this.handleGetAttachment(request);
				case '/events/latest':
					return this.handleGetLatestEvents(request);
				case '/stats':
					return this.handleGetStats(request);
				case '/config':
					return this.handleGetConfig();
				case '/config/update':
					return this.handleUpdateConfig(request);
				case '/rate-limit-status':
					return this.handleRateLimitStatus();
				case '/tags':
					return this.handleGetTags(request);
				case '/tag-values':
					return this.handleGetTagValues(request);
				case '/settings':
					return this.handleGetSettings();
				case '/settings/update':
					return this.handleUpdateSettings(request);
				case '/environments':
					return this.handleGetEnvironments();
				case '/summary':
					return this.handleGetSummary();
				case '/issue/comments':
					return this.handleGetComments(request);
				case '/issue/comment/add':
					return this.handleAddComment(request);
				case '/issue/comment/delete':
					return this.handleDeleteComment(request);
				case '/issue/activity':
					return this.handleGetActivity(request);
				case '/releases':
					return this.handleGetReleases(request);
				case '/release':
					return this.handleGetRelease(request);
				case '/issue/snooze':
					return this.handleSnoozeIssue(request);
				case '/issue/unsnooze':
					return this.handleUnsnoozeIssue(request);
				case '/sourcemaps/upload':
					return this.handleUploadSourceMap(request);
				case '/sourcemaps/list':
					return this.handleListSourceMaps(request);
				case '/sourcemaps/get':
					return this.handleGetSourceMap(request);
				case '/sourcemaps/delete':
					return this.handleDeleteSourceMap(request);
				case '/filters':
					return this.handleGetFilters();
				case '/filters/create':
					return this.handleCreateFilter(request);
				case '/filters/update':
					return this.handleUpdateFilter(request);
				case '/filters/delete':
					return this.handleDeleteFilter(request);
				case '/issues/merge':
					return this.handleMergeIssues(request);
				case '/purge':
					return this.handlePurge(request);
				case '/attachment/r2-probe':
					// Test-only DO↔R2 binding probe (inert without the test
					// fault-injection binding)
					if (this.env.ATTACHMENT_FAULT_INJECTION === 'enabled') {
						return this.handleR2Probe();
					}
					return this.notFound();
				case '/migration-flip-arm':
					// Test-only one-shot marker consumed by the next alarm
					// migration run (alarms carry no headers)
					if (this.env.ATTACHMENT_FAULT_INJECTION === 'enabled') {
						return this.handleMigrationFlipArm();
					}
					return this.notFound();
				default:
					return this.notFound();
			}
		} catch (error) {
			console.error('ProjectState error:', error);
			return new Response(
				JSON.stringify({
					error: 'internal_error',
					message: error instanceof Error ? error.message : 'Unknown error',
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } },
			);
		}
	}

	private notFound(): Response {
		return new Response(JSON.stringify({ error: 'not_found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	/**
	 * Project id for R2 key prefixes (`p/{projectId}/…`). Persisted in
	 * `project_config` by the lazy /touch (which precedes every upload), the
	 * purge route, and the ingest-with-attachments boundary.
	 */
	private getProjectId(): string | null {
		return this.getConfigValue('project_id');
	}

	private persistProjectId(projectId: unknown): void {
		if (typeof projectId === 'string' && projectId.length > 0) {
			this.setConfigValue('project_id', projectId);
		}
	}

	/**
	 * Idempotent usage-counter seed: safe to run inside any transaction, so
	 * retention deletes arriving before any post-upgrade ingest cannot drift
	 * the counter.
	 */
	private seedAttachmentUsage(): void {
		this.sql.exec(`INSERT INTO attachment_usage (id, bytes)
			SELECT 1, COALESCE((SELECT SUM(size) FROM attachments), 0)
			WHERE NOT EXISTS (SELECT 1 FROM attachment_usage)`);
	}

	private attachmentUsageBytes(): number {
		this.seedAttachmentUsage();
		const rows = this.sql.exec('SELECT bytes FROM attachment_usage WHERE id = 1').toArray();
		return rows.length > 0 ? (rows[0].bytes as number) : 0;
	}

	/** Best-effort blob deletion after SQL commit; GC is the backstop. */
	private async deleteAttachmentBlobs(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		try {
			await createAttachmentStore(this.env, null).deleteKeys(keys);
		} catch (error) {
			console.error(
				'Attachment blob delete failed (GC will reclaim):',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
		}
	}

	/**
	 * Lazy touch from the ingestion route at the first storable attachment:
	 * ensures schema + alarm (GC coverage for any blob the request may
	 * orphan) and returns the rate-limit snapshot so a limited project can
	 * be rejected before uploading up to 21 MiB of otherwise-doomed blobs.
	 */
	private async handleTouch(request: Request): Promise<Response> {
		// ensureSchema (including alarm guarantee) already ran in fetch()
		try {
			const body = (await request.json()) as { projectId?: string };
			this.persistProjectId(body.projectId);
		} catch {
			// No/invalid body — rate snapshot still served
		}
		return this.jsonResponse({
			maxEventsPerHour: Number.parseInt(this.getConfigValue('max_events_per_hour') || '0', 10),
			currentHourCount: this.currentRateCount(),
			isLimited: this.isRateLimited(),
			retryAfterSeconds: this.retryAfterSeconds() || 3600,
		});
	}

	/**
	 * Test-only DO↔R2 binding probe: drives put/head/get/list/delete through
	 * the real store factory from inside the DO. Proves the DO can operate
	 * the bucket directly (the design assumption for lifecycle deletes,
	 * purge sweeps, GC and inline migration).
	 */
	private async handleR2Probe(): Promise<Response> {
		try {
			const projectId = this.getProjectId() ?? 'probe';
			const key = `p/${projectId}/probe/${crypto.randomUUID()}`;
			const payload = new TextEncoder().encode('probe');
			const store = createAttachmentStore(this.env, null);
			await store.uploadAttachment(key, payload, payload.byteLength);
			const head = await this.env.ATTACHMENTS.head(key);
			const got = await this.env.ATTACHMENTS.get(key);
			const bytes = got ? new Uint8Array(await got.arrayBuffer()) : null;
			const listed = await store.listPage(`p/${projectId}/probe/`, null);
			await store.deleteKeys([key]);
			const after = await this.env.ATTACHMENTS.head(key);
			return this.jsonResponse({
				ok:
					head !== null &&
					bytes !== null &&
					bytes.byteLength === payload.byteLength &&
					listed.objects.some((o) => o.key === key) &&
					after === null,
				resolvedProjectId: projectId,
			});
		} catch (error) {
			return this.jsonResponse(
				{ ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
				500,
			);
		}
	}

	/** Test-only: arm the one-shot migration-flip fault for the next alarm. */
	private handleMigrationFlipArm(): Response {
		this.setConfigValue('migration_flip_fault', '1');
		return this.jsonResponse({ armed: true });
	}

	/**
	 * Purge: drop every table row and all KV storage in this Durable Object.
	 * Called when a project is deleted so tenant data does not outlive it.
	 *
	 * Saga: blobs are swept from R2 FIRST (prefix list + batched deletes,
	 * continuation persisted per page), and only once the prefix is empty is
	 * the DO state wiped. While `purge_pending` is set, ingest routes reject
	 * with 503 so a concurrent in-flight ingest cannot recreate state under
	 * the sweep. If the sweep cannot complete in one run it retries on
	 * subsequent alarms.
	 */
	private async handlePurge(request: Request): Promise<Response> {
		let projectId: string | null = null;
		let sweepFault = false;
		try {
			const body = (await request.json()) as { projectId?: string; fault?: string };
			projectId = typeof body.projectId === 'string' ? body.projectId : null;
			// Test fault forwarding (purge-sweep) — only honored under the
			// test binding
			sweepFault =
				this.env.ATTACHMENT_FAULT_INJECTION === 'enabled' && body.fault === 'purge-sweep';
		} catch {
			// No/invalid body — legacy purge callers
		}
		if (projectId) this.persistProjectId(projectId);

		if (this.getConfigValue('purge_pending') !== '1') {
			this.setConfigValue('purge_pending', '1');
			this.setConfigValue('purge_cursor', '');
		}

		const complete = await this.runPurgeSweep(sweepFault);
		if (!complete) {
			// Sweep failed mid-way: continuation is persisted; the alarm
			// retries until the prefix is empty. DO state survives until then.
			await this.scheduleNextAlarm();
			return this.jsonResponse({ purged: false, pending: true });
		}

		await this.ctx.storage.deleteAll();
		// Allow the schema to be recreated lazily on the next request
		this.initialized = false;
		return this.jsonResponse({ purged: true });
	}

	/**
	 * One purge sweep pass. Returns true when the project prefix is empty
	 * (safe to wipe DO state); false when the sweep must resume later.
	 */
	private async runPurgeSweep(sweepFault: boolean): Promise<boolean> {
		const projectId = this.getProjectId();
		if (!projectId) {
			// No persisted project id means no R2 object can exist for this
			// project (the touch that persists it precedes every upload).
			return true;
		}
		const store = createAttachmentStore(this.env, sweepFault ? 'purge-sweep' : null);
		const prefix = projectPrefix(projectId);
		let cursor = this.getConfigValue('purge_cursor') || null;
		try {
			for (;;) {
				const page = await store.listPage(prefix, cursor);
				if (page.objects.length > 0) {
					await store.deleteKeys(page.objects.map((o) => o.key));
				}
				cursor = page.cursor;
				this.setConfigValue('purge_cursor', cursor ?? '');
				if (!cursor) return true;
			}
		} catch (error) {
			console.error(
				'Purge sweep incomplete; will retry on next alarm:',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
			return false;
		}
	}

	private async handleIngest(request: Request): Promise<Response> {
		const event = (await request.json()) as SentryEvent;
		return this.ingestEvent(event);
	}

	/**
	 * Internal ingest boundary for the worker's envelope route: accepts the
	 * already-validated event plus its extracted attachments (payload in R2
	 * via `r2Key`, or legacy inline `data`). Same semantics as `/ingest`
	 * (bare event) for callers that have no attachments. The worker also
	 * passes the project id so alarm-driven R2 work (GC, migration) knows
	 * its key prefix even if this DO was never touched.
	 */
	private async handleIngestWithAttachments(request: Request): Promise<Response> {
		const { event, attachments, projectId } = (await request.json()) as {
			event: SentryEvent;
			attachments?: ExtractedAttachment[];
			projectId?: string;
		};
		this.persistProjectId(projectId);
		return this.ingestEvent(event, Array.isArray(attachments) ? attachments : []);
	}

	/**
	 * Ingest one event (plus optional pre-validated attachments).
	 *
	 * All async preparation (sanitize, redact, user hash, attachment budgets)
	 * happens before any mutation; the entire mutation sequence then runs
	 * inside a single `transactionSync` boundary, so a mid-sequence failure
	 * (e.g. a constraint violation) rolls back every SQL effect — event,
	 * issue, tags, stats and the persisted rate-limit counter alike. The
	 * in-memory rate-limit cache is refreshed from the persisted counter only
	 * after the transaction commits: a rollback consumes no quota. Policy
	 * drops (over-budget attachments, filtered events) are decided before the
	 * transaction and reported, never thrown. Duplicate detection runs inside
	 * the boundary, so a retry after a rollback succeeds cleanly.
	 */
	private async ingestEvent(
		rawEvent: SentryEvent,
		attachments: ExtractedAttachment[] = [],
	): Promise<Response> {
		// A purge in progress is deleting this project's state; accepting an
		// ingest now could recreate rows/blobs under the sweep.
		if (this.getConfigValue('purge_pending') === '1') {
			return new Response(
				JSON.stringify({ error: 'purge_pending', message: 'Project purge in progress' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } },
			);
		}

		// Check rate limit before processing
		const rateCheck = this.checkRateLimit();
		if (!rateCheck.allowed) {
			return new Response(
				JSON.stringify({ error: 'rate_limited', message: 'Project event quota exceeded' }),
				{
					status: 429,
					headers: {
						'Content-Type': 'application/json',
						'Retry-After': String(rateCheck.retryAfter || 3600),
					},
				},
			);
		}

		const event = this.redactEvent(sanitizeEvent(rawEvent));

		const eventId = event.event_id || crypto.randomUUID();
		const now = new Date().toISOString();
		const timestamp = event.timestamp || now;
		const userHash = await this.hashUserIdentifier(event.user);

		// Attachment budgets are decided pre-transaction and reported, never thrown
		const { storable, dropped } = this.applyAttachmentBudgets(attachments);
		const hasAttachments = attachments.length > 0;

		let outcome: IngestOutcome;
		try {
			outcome = this.ctx.storage.transactionSync(() =>
				this.ingestEventTransaction(event, eventId, timestamp, now, userHash, storable),
			);
		} catch (error) {
			// The whole transaction rolled back: no event, issue, tags, stats or
			// persisted rate-limit effects survive, and the in-memory cache was
			// never touched. Surface a clean 500 without echoing attacker input.
			console.error(
				'Ingest transaction failed:',
				error instanceof Error ? error.message.slice(0, 200) : 'unknown',
			);
			return new Response(
				JSON.stringify({ error: 'internal_error', message: 'Event ingest failed' }),
				{ status: 500, headers: { 'Content-Type': 'application/json' } },
			);
		}

		// Refresh the in-memory rate-limit cache from the persisted counter
		// only after the transaction commits.
		if (outcome.kind === 'stored') {
			this.refreshRateLimitCount();
		}

		if (outcome.kind === 'duplicate') {
			return this.jsonResponse({ eventId, duplicate: true });
		}

		if (outcome.kind === 'rate_limited') {
			return new Response(
				JSON.stringify({ error: 'rate_limited', message: 'Project event quota exceeded' }),
				{
					status: 429,
					headers: {
						'Content-Type': 'application/json',
						'Retry-After': String(this.retryAfterSeconds() || 3600),
					},
				},
			);
		}

		if (outcome.kind === 'purge_pending') {
			return new Response(
				JSON.stringify({ error: 'purge_pending', message: 'Project purge in progress' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (outcome.kind === 'filtered') {
			return this.jsonResponse({
				filtered: true,
				eventId,
				...(hasAttachments
					? {
							droppedAttachments: attachments.map((a) => ({
								filename: a.filename,
								reason: 'event_filtered' as const,
							})),
						}
					: {}),
			});
		}

		return this.jsonResponse({
			eventId,
			issueId: outcome.issueId,
			isNewIssue: outcome.isNewIssue,
			title: outcome.title,
			level: outcome.level,
			culprit: outcome.culprit,
			...(hasAttachments ? { droppedAttachments: dropped } : {}),
			// R2 keys whose metadata rows committed — the worker deletes any
			// uploaded key not in this list (saga hygiene).
			...(hasAttachments
				? {
						storedR2Keys: storable
							.map((a) => a.r2Key)
							.filter((key): key is string => typeof key === 'string'),
					}
				: {}),
		});
	}

	/** The synchronous mutation sequence of `ingestEvent`, run transactionally. */
	private ingestEventTransaction(
		event: SentryEvent,
		eventId: string,
		timestamp: string,
		now: string,
		userHash: string | null,
		attachments: ExtractedAttachment[],
	): IngestOutcome {
		// Purge admission is re-checked inside the transaction: the async
		// preparation before it (user hashing) can suspend the handler while
		// a purge starts, and writes must not land under the sweep.
		if (this.getConfigValue('purge_pending') === '1') {
			return { kind: 'purge_pending' };
		}

		// Atomic quota admission: the pre-transaction check is advisory (it
		// runs before async prep, where requests can interleave); this one
		// reads the persisted counter inside the transaction and is exact.
		const maxPerHour = Number.parseInt(this.getConfigValue('max_events_per_hour') || '0', 10);
		const bucket = this.getHourBucket(now);
		if (maxPerHour > 0) {
			const countRow = this.sql
				.exec('SELECT count FROM rate_limit_counters WHERE bucket = ?', bucket)
				.toArray();
			const currentCount = countRow.length > 0 ? (countRow[0].count as number) : 0;
			if (currentCount >= maxPerHour) {
				return { kind: 'rate_limited' };
			}
		}

		// Duplicate event_id: acknowledge without double-counting (the client
		// controls event_id, so replays must be idempotent)
		const duplicate = this.sql.exec('SELECT 1 FROM events WHERE id = ?', eventId).toArray();
		if (duplicate.length > 0) {
			return { kind: 'duplicate' };
		}

		// Generate fingerprint
		const fingerprint = generateFingerprint(event);

		// Check inbound filters
		const enabledFilters = this.sql
			.exec('SELECT * FROM inbound_filters WHERE enabled = 1')
			.toArray();

		const matchedFilterId = this.shouldFilterEvent(event, enabledFilters);
		if (matchedFilterId) {
			this.sql.exec(
				'UPDATE inbound_filters SET dropped_count = dropped_count + 1 WHERE id = ?',
				matchedFilterId,
			);
			return { kind: 'filtered' };
		}
		// Check if this fingerprint has been redirected (from a merged issue)
		let effectiveFingerprint = fingerprint;
		const redirectRows = this.sql
			.exec('SELECT target_issue_id FROM fingerprint_redirects WHERE fingerprint = ?', fingerprint)
			.toArray();
		if (redirectRows.length > 0) {
			const targetIssueId = redirectRows[0].target_issue_id as string;
			const targetIssueRows = this.sql
				.exec('SELECT fingerprint FROM issues WHERE id = ?', targetIssueId)
				.toArray();
			if (targetIssueRows.length > 0) {
				effectiveFingerprint = targetIssueRows[0].fingerprint as string;
			}
		}

		// Check for existing issue
		const existingRows = this.sql
			.exec('SELECT id, count, status FROM issues WHERE fingerprint = ?', effectiveFingerprint)
			.toArray();
		const existingIssue = existingRows.length > 0 ? existingRows[0] : null;

		let issueId: string;
		let newIssueTitle: string | undefined;
		let newIssueCulprit: string | null | undefined;

		if (existingIssue) {
			// Update existing issue
			issueId = existingIssue.id as string;
			this.sql.exec(
				'UPDATE issues SET last_seen = ?, count = count + 1 WHERE id = ?',
				now,
				issueId,
			);
		} else {
			// Create new issue
			issueId = crypto.randomUUID();
			const title = extractTitle(event);
			const culprit = extractCulprit(event);
			const metadata = extractMetadata(event);
			newIssueTitle = title;
			newIssueCulprit = culprit;

			this.sql.exec(
				`INSERT INTO issues (id, fingerprint, title, culprit, level, platform, first_seen, last_seen, count, status, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unresolved', ?)`,
				issueId,
				fingerprint,
				title,
				culprit,
				event.level || 'error',
				event.platform || 'javascript',
				now,
				now,
				JSON.stringify(metadata),
			);
		}

		// Store event
		this.sql.exec(
			`INSERT INTO events (id, issue_id, timestamp, received_at, level, platform, environment, release, transaction_name, user_id, user_email, user_ip, tags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			eventId,
			issueId,
			timestamp,
			now,
			event.level || 'error',
			event.platform || null,
			event.environment || null,
			event.release || null,
			event.transaction || null,
			event.user?.id || null,
			event.user?.email || null,
			event.user?.ip_address || null,
			event.tags ? JSON.stringify(event.tags) : null,
			JSON.stringify(event),
		);

		// Store indexed tags
		if (event.tags && typeof event.tags === 'object') {
			for (const [key, value] of Object.entries(event.tags)) {
				if (
					typeof key === 'string' &&
					typeof value === 'string' &&
					key.length <= 200 &&
					value.length <= 200
				) {
					this.sql.exec(
						'INSERT OR IGNORE INTO event_tags (event_id, issue_id, key, value) VALUES (?, ?, ?, ?)',
						eventId,
						issueId,
						key,
						value,
					);
				}
			}
		}

		// Update hourly stats. Bucket by server receipt time: client timestamps
		// are attacker-controlled and previously let future-dated rows outlive
		// retention pruning (which runs on received_at).
		this.sql.exec(
			`INSERT INTO issue_stats (issue_id, bucket, count)
       VALUES (?, ?, 1)
       ON CONFLICT (issue_id, bucket) DO UPDATE SET count = count + 1`,
			issueId,
			bucket,
		);

		// Update rate limit counter (persisted; the in-memory cache is
		// refreshed from it only after the transaction commits). Old-hour
		// buckets are cleaned up here too, so every persisted rate-limit
		// mutation lives inside the transaction boundary.
		this.sql.exec(
			'INSERT INTO rate_limit_counters (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1',
			bucket,
		);
		this.sql.exec('DELETE FROM rate_limit_counters WHERE bucket < ?', bucket);
		// Track environment
		const environment = event.environment || null;
		if (environment) {
			this.sql.exec(
				`INSERT INTO issue_environments (issue_id, environment, first_seen, last_seen, event_count)
				 VALUES (?, ?, ?, ?, 1)
				 ON CONFLICT (issue_id, environment) DO UPDATE SET
				   last_seen = excluded.last_seen,
				   event_count = event_count + 1`,
				issueId,
				environment,
				now,
				now,
			);
		}

		// Track release and detect regressions
		if (event.release) {
			try {
				const releaseVersion = event.release;
				const isNewIssue = !existingIssue;

				// Upsert release record
				this.sql.exec(
					`INSERT INTO releases (version, first_seen, last_seen, event_count, issue_count, new_issue_count)
					 VALUES (?, ?, ?, 1, 0, 0)
					 ON CONFLICT (version) DO UPDATE SET
					   last_seen = ?,
					   event_count = event_count + 1`,
					releaseVersion,
					now,
					now,
					now,
				);

				// Link issue to release
				const existingLink = this.sql
					.exec(
						'SELECT release_version FROM release_issues WHERE release_version = ? AND issue_id = ?',
						releaseVersion,
						issueId,
					)
					.toArray();

				if (existingLink.length > 0) {
					this.sql.exec(
						'UPDATE release_issues SET event_count = event_count + 1 WHERE release_version = ? AND issue_id = ?',
						releaseVersion,
						issueId,
					);
				} else {
					this.sql.exec(
						'INSERT INTO release_issues (release_version, issue_id, first_seen_in_release, event_count) VALUES (?, ?, ?, 1)',
						releaseVersion,
						issueId,
						now,
					);
					// Update issue_count on the release
					this.sql.exec(
						'UPDATE releases SET issue_count = issue_count + 1 WHERE version = ?',
						releaseVersion,
					);
					// If this is a brand new issue, increment new_issue_count
					if (isNewIssue) {
						this.sql.exec(
							'UPDATE releases SET new_issue_count = new_issue_count + 1 WHERE version = ?',
							releaseVersion,
						);
					}
				}

				// Regression detection: reopen resolved issues
				if (existingIssue && existingIssue.status === 'resolved') {
					this.sql.exec("UPDATE issues SET status = 'unresolved' WHERE id = ?", issueId);
				}
			} catch (e) {
				console.error('Release tracking failed:', e);
			}
		}

		// Track unique users
		if (event.user && userHash) {
			const existingUserRows = this.sql
				.exec(
					'SELECT issue_id FROM issue_users WHERE issue_id = ? AND user_hash = ?',
					issueId,
					userHash,
				)
				.toArray();

			if (existingUserRows.length > 0) {
				this.sql.exec(
					'UPDATE issue_users SET last_seen = ? WHERE issue_id = ? AND user_hash = ?',
					now,
					issueId,
					userHash,
				);
			} else {
				this.sql.exec(
					'INSERT INTO issue_users (issue_id, user_hash, first_seen, last_seen) VALUES (?, ?, ?, ?)',
					issueId,
					userHash,
					now,
					now,
				);
				// Update user count
				this.sql.exec('UPDATE issues SET user_count = user_count + 1 WHERE id = ?', issueId);
			}
		}

		// Store attachments. The deterministic id (eventId:index) plus the
		// narrow ON CONFLICT scope make replays idempotent while CHECK and
		// FK violations still throw and roll back the whole transaction.
		// R2-backed attachments keep only ~200 bytes of metadata here
		// (`data=''` sentinel); the legacy `data` payload remains accepted
		// for inline rows, which the alarm migrates to R2.
		let insertedBytes = 0;
		for (let i = 0; i < attachments.length; i++) {
			const attachment = attachments[i];
			const isR2 = typeof attachment.r2Key === 'string' && attachment.r2Key.length > 0;
			this.sql.exec(
				`INSERT INTO attachments (id, event_id, filename, content_type, size, data, created_at, r2_key, storage)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO NOTHING`,
				`${eventId}:${i}`,
				eventId,
				attachment.filename,
				attachment.contentType,
				attachment.size,
				isR2 ? '' : (attachment.data ?? ''),
				now,
				isR2 ? attachment.r2Key : null,
				isR2 ? 'r2' : 'inline',
			);
			insertedBytes += attachment.size;
		}
		if (attachments.length > 0) {
			this.seedAttachmentUsage();
			this.sql.exec('UPDATE attachment_usage SET bytes = bytes + ? WHERE id = 1', insertedBytes);
		}

		return {
			kind: 'stored',
			issueId,
			isNewIssue: !existingIssue,
			title: newIssueTitle,
			level: event.level || 'error',
			culprit: newIssueCulprit ?? null,
		};
	}

	/**
	 * Apply the per-project attachment byte budget to a batch of extracted
	 * attachments. Decided before the transaction and reported as drops;
	 * existing data is never auto-deleted to make room. The budget bounds R2
	 * usage, not the DO (metadata rows are uncounted). Default 10 GiB,
	 * tunable via config (`maxAttachmentBytes`); "unlimited" is a very large
	 * value. Usage is read from the persisted counter (seeded idempotently).
	 */
	private applyAttachmentBudgets(attachments: ExtractedAttachment[]): {
		storable: ExtractedAttachment[];
		dropped: DroppedAttachment[];
	} {
		if (attachments.length === 0) {
			return { storable: [], dropped: [] };
		}
		const bytesConfig = Number.parseInt(
			this.getConfigValue('max_attachment_total_bytes') || '',
			10,
		);
		const maxBytes =
			Number.isInteger(bytesConfig) && bytesConfig > 0 ? bytesConfig : MAX_PROJECT_ATTACHMENT_BYTES;

		let bytes = this.attachmentUsageBytes();
		const storable: ExtractedAttachment[] = [];
		const dropped: DroppedAttachment[] = [];
		for (const attachment of attachments) {
			if (bytes + attachment.size > maxBytes) {
				dropped.push({ filename: attachment.filename, reason: 'project_attachment_quota' });
				continue;
			}
			storable.push(attachment);
			bytes += attachment.size;
		}
		return { storable, dropped };
	}

	private static readonly ALLOWED_SORT_FIELDS = new Set([
		'last_seen',
		'first_seen',
		'count',
		'user_count',
		'level',
		'title',
	]);

	private async handleGetIssues(request: Request): Promise<Response> {
		const { status, level, environment, query, sort, cursor, limit, tags } =
			(await request.json()) as {
				status?: string;
				level?: string;
				environment?: string;
				query?: string;
				sort?: string;
				cursor?: string;
				limit?: number;
				tags?: string[];
			};

		const pageLimit = clampLimit(limit, 25);
		const sortField = sort && ProjectState.ALLOWED_SORT_FIELDS.has(sort) ? sort : 'last_seen';
		const sortOrder = 'DESC';
		const now = new Date().toISOString();

		let sql = 'SELECT * FROM issues WHERE 1=1';
		const params: (string | number)[] = [];

		if (status === 'snoozed') {
			// Show only currently snoozed issues
			sql += ' AND snoozed_until IS NOT NULL AND snoozed_until > ?';
			params.push(now);
		} else {
			if (status) {
				sql += ' AND status = ?';
				params.push(status);
			}
			// Hide snoozed issues from default views
			sql += ' AND (snoozed_until IS NULL OR snoozed_until <= ?)';
			params.push(now);
		}

		if (level) {
			sql += ' AND level = ?';
			params.push(level);
		}

		if (environment) {
			sql += ' AND id IN (SELECT issue_id FROM issue_environments WHERE environment = ?)';
			params.push(environment);
		}

		if (query) {
			sql += " AND (title LIKE ? ESCAPE '\\' OR culprit LIKE ? ESCAPE '\\')";
			const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
			params.push(`%${escaped}%`, `%${escaped}%`);
		}

		if (tags && tags.length > 0) {
			for (let i = 0; i < Math.min(tags.length, 5); i++) {
				const [tagKey, ...rest] = tags[i].split(':');
				const tagValue = rest.join(':');
				if (tagKey && tagValue) {
					sql +=
						' AND id IN (SELECT DISTINCT issue_id FROM event_tags WHERE key = ? AND value = ?)';
					params.push(tagKey, tagValue);
				}
			}
		}

		if (cursor) {
			sql += ` AND ${sortField} < ?`;
			params.push(cursor);
		}

		sql += ` ORDER BY ${sortField} ${sortOrder} LIMIT ?`;
		params.push(pageLimit + 1);

		const rows = this.sql.exec(sql, ...params).toArray();
		const hasMore = rows.length > pageLimit;
		const issues = rows.slice(0, pageLimit).map((row) => this.rowToIssue(row));

		// Cursor = the sort-key value of the last row ON the page. It must be
		// read from the raw SQL row: `sortField` names the snake_case column
		// (`last_seen`, …), which does not exist on the camelCase Issue
		// objects — indexing those silently yielded undefined for the default
		// sort and dropped every continuation cursor.
		const nextCursor =
			hasMore && issues.length > 0
				? ((rows[issues.length - 1] as Record<string, unknown>)[sortField] as string | number)
				: undefined;

		return this.jsonResponse({
			issues,
			nextCursor,
			hasMore,
		});
	}

	private async handleGetIssue(request: Request): Promise<Response> {
		const { issueId } = (await request.json()) as { issueId: string };

		const rows = this.sql.exec('SELECT * FROM issues WHERE id = ?', issueId).toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'issue_not_found' }, 404);
		}

		const row = rows[0];

		// Get recent stats (7 days of hourly buckets)
		const statsRows = this.sql
			.exec(
				'SELECT bucket, count FROM issue_stats WHERE issue_id = ? ORDER BY bucket DESC LIMIT 168',
				issueId,
			)
			.toArray();

		const stats = statsRows.map((s) => ({
			bucket: s.bucket as string,
			count: s.count as number,
		}));

		return this.jsonResponse({
			issue: this.rowToIssue(row),
			stats,
		});
	}

	private async handleUpdateIssue(request: Request): Promise<Response> {
		const { issueId, status, userId, userName } = (await request.json()) as {
			issueId: string;
			status?: string;
			userId?: string;
			userName?: string;
		};

		if (!issueId) {
			return this.jsonResponse({ error: 'missing_issue_id' }, 400);
		}

		const updates: string[] = [];
		const params: (string | null)[] = [];

		// Get previous status before updating
		let previousStatus: string | undefined;
		if (status) {
			const current = this.sql.exec('SELECT status FROM issues WHERE id = ?', issueId).toArray();
			previousStatus = current.length > 0 ? (current[0].status as string) : 'unknown';
			updates.push('status = ?');
			params.push(status);
		}

		if (updates.length === 0) {
			return this.jsonResponse({ error: 'no_updates' }, 400);
		}

		params.push(issueId);
		this.sql.exec(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`, ...params);

		// Record status change activity
		if (status && previousStatus) {
			const activityId = crypto.randomUUID();
			const now = new Date().toISOString();
			this.sql.exec(
				`INSERT INTO issue_activity (id, issue_id, user_id, user_name, type, data, created_at)
				 VALUES (?, ?, ?, ?, 'status_change', ?, ?)`,
				activityId,
				issueId,
				userId || 'system',
				userName || 'System',
				JSON.stringify({ from: previousStatus, to: status }),
				now,
			);
		}

		const row = this.sql.exec('SELECT * FROM issues WHERE id = ?', issueId).one();
		return this.jsonResponse({ issue: row ? this.rowToIssue(row) : null });
	}

	private async handleDeleteIssue(request: Request): Promise<Response> {
		const { issueId } = (await request.json()) as { issueId: string };

		if (!issueId) {
			return this.jsonResponse({ error: 'missing_issue_id' }, 400);
		}

		// Collect blob keys/sizes before the cascade delete, then delete rows
		// and decrement the usage counter in one transaction; blobs go after
		// the commit (best-effort, GC backstop).
		const doomed = this.sql
			.exec(
				`SELECT r2_key, size FROM attachments
				 WHERE storage = 'r2' AND r2_key IS NOT NULL
				   AND event_id IN (SELECT id FROM events WHERE issue_id = ?)`,
				issueId,
			)
			.toArray();
		const totalBytes = this.sumAttachmentBytes(
			this.sql
				.exec(
					`SELECT COALESCE(SUM(size), 0) AS total FROM attachments
					 WHERE event_id IN (SELECT id FROM events WHERE issue_id = ?)`,
					issueId,
				)
				.toArray(),
		);

		this.ctx.storage.transactionSync(() => {
			// Seed BEFORE the cascade: on the first delete after upgrade the
			// counter row may not exist yet, and seeding after the delete
			// would already exclude the deleted bytes (undercounting).
			this.seedAttachmentUsage();
			// Delete cascade handles events, stats, users
			this.sql.exec('DELETE FROM issues WHERE id = ?', issueId);
			this.sql.exec(
				'UPDATE attachment_usage SET bytes = MAX(0, bytes - ?) WHERE id = 1',
				totalBytes,
			);
		});

		await this.deleteAttachmentBlobs(doomed.map((row) => row.r2_key as string));

		return this.jsonResponse({ success: true });
	}

	/** Sum a `SELECT ... AS total` single-row result safely. */
	private sumAttachmentBytes(rows: Array<Record<string, SqlStorageValue>>): number {
		return rows.length > 0 ? Number(rows[0].total ?? 0) || 0 : 0;
	}

	private async handleBulkUpdateIssues(request: Request): Promise<Response> {
		const { issueIds, status, action } = (await request.json()) as {
			issueIds: string[];
			status?: string;
			action?: 'delete';
		};

		if (!issueIds || !Array.isArray(issueIds) || issueIds.length === 0) {
			return this.jsonResponse({ error: 'missing_issue_ids' }, 400);
		}

		if (issueIds.length > 100) {
			return this.jsonResponse(
				{ error: 'too_many_issues', message: 'Maximum 100 issues per bulk operation' },
				400,
			);
		}

		const validStatuses = new Set(['unresolved', 'resolved', 'ignored']);
		if (status && !validStatuses.has(status)) {
			return this.jsonResponse({ error: 'invalid_status' }, 400);
		}

		const placeholders = issueIds.map(() => '?').join(', ');

		if (action === 'delete') {
			// Blob keys/sizes before the cascade, then transactional delete +
			// usage decrement, then best-effort blob deletion after commit.
			const doomed = this.sql
				.exec(
					`SELECT r2_key FROM attachments
					 WHERE storage = 'r2' AND r2_key IS NOT NULL
					   AND event_id IN (SELECT id FROM events WHERE issue_id IN (${placeholders}))`,
					...issueIds,
				)
				.toArray();
			const totalBytes = this.sumAttachmentBytes(
				this.sql
					.exec(
						`SELECT COALESCE(SUM(size), 0) AS total FROM attachments
						 WHERE event_id IN (SELECT id FROM events WHERE issue_id IN (${placeholders}))`,
						...issueIds,
					)
					.toArray(),
			);
			let affected = 0;
			this.ctx.storage.transactionSync(() => {
				// Seed BEFORE the delete (see handleDeleteIssue)
				this.seedAttachmentUsage();
				const cursor = this.sql.exec(
					`DELETE FROM issues WHERE id IN (${placeholders})`,
					...issueIds,
				);
				affected = cursor.rowsWritten;
				this.sql.exec(
					'UPDATE attachment_usage SET bytes = MAX(0, bytes - ?) WHERE id = 1',
					totalBytes,
				);
			});
			await this.deleteAttachmentBlobs(doomed.map((row) => row.r2_key as string));
			return this.jsonResponse({ success: true, affected });
		}

		if (status) {
			this.sql.exec(
				`UPDATE issues SET status = ? WHERE id IN (${placeholders})`,
				status,
				...issueIds,
			);
			const changedRow = this.sql.exec('SELECT changes() as n').one();
			const affected = changedRow ? (changedRow.n as number) : 0;
			return this.jsonResponse({ success: true, affected });
		}

		return this.jsonResponse({ error: 'no_action' }, 400);
	}

	private async handleGetIssueEvents(request: Request): Promise<Response> {
		const { issueId, cursor, limit } = (await request.json()) as {
			issueId: string;
			cursor?: string;
			limit?: number;
		};

		const pageLimit = clampLimit(limit, 25);

		let sql = 'SELECT * FROM events WHERE issue_id = ?';
		const params: (string | number)[] = [issueId];

		if (cursor) {
			sql += ' AND timestamp < ?';
			params.push(cursor);
		}

		sql += ' ORDER BY timestamp DESC LIMIT ?';
		params.push(pageLimit + 1);

		const rows = this.sql.exec(sql, ...params).toArray();
		const hasMore = rows.length > pageLimit;
		const events = rows.slice(0, pageLimit).map((row) => JSON.parse(row.data as string));

		const nextCursor =
			hasMore && events.length > 0
				? (events[events.length - 1] as SentryEvent).timestamp
				: undefined;

		return this.jsonResponse({
			events,
			nextCursor,
			hasMore,
		});
	}

	private async handleGetEvent(request: Request): Promise<Response> {
		const { eventId } = (await request.json()) as { eventId: string };

		const rows = this.sql.exec('SELECT * FROM events WHERE id = ?', eventId).toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'event_not_found' }, 404);
		}

		const row = rows[0];
		return this.jsonResponse({
			event: JSON.parse(row.data as string),
			issueId: row.issue_id,
		});
	}

	/**
	 * Attachment metadata for one event (no payload data). `issueId` is
	 * derived from the event at read time rather than stored, so issue merges
	 * cannot strand attachment links.
	 */
	private async handleListEventAttachments(request: Request): Promise<Response> {
		const { eventId, orderBy, offset, limit } = (await request.json()) as {
			eventId?: string;
			orderBy?: 'name';
			offset?: number;
			limit?: number;
		};

		if (!eventId) {
			return this.jsonResponse({ error: 'missing_event_id' }, 400);
		}

		const eventRows = this.sql.exec('SELECT issue_id FROM events WHERE id = ?', eventId).toArray();
		if (eventRows.length === 0) {
			return this.jsonResponse({ error: 'event_not_found' }, 404);
		}

		// Compat mode (Sentry /api/0 surface): any of these opts into a paged,
		// name-ordered window plus a `total` count. The default path (native
		// route) keeps its exact historical shape: rowid order, no window, no
		// `total` key.
		if (orderBy === 'name' || offset !== undefined || limit !== undefined) {
			const windowLimit =
				Number.isInteger(limit) && (limit as number) >= 1 ? (limit as number) : 100;
			const windowOffset =
				Number.isInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0;
			const rows = this.sql
				.exec(
					`SELECT id, event_id, filename, content_type, size, created_at FROM attachments
					 WHERE event_id = ? ORDER BY filename LIMIT ? OFFSET ?`,
					eventId,
					windowLimit,
					windowOffset,
				)
				.toArray();
			const totalRows = this.sql
				.exec('SELECT COUNT(*) as total FROM attachments WHERE event_id = ?', eventId)
				.toArray();
			return this.jsonResponse({
				issueId: eventRows[0].issue_id,
				attachments: rows.map((row) => ({
					id: row.id as string,
					eventId: row.event_id as string,
					filename: row.filename as string,
					contentType: (row.content_type as string) ?? 'text/plain',
					size: row.size as number,
					createdAt: row.created_at as string,
				})),
				total: totalRows[0].total as number,
			});
		}

		const rows = this.sql
			.exec(
				`SELECT id, event_id, filename, content_type, size, created_at FROM attachments
				 WHERE event_id = ? ORDER BY rowid`,
				eventId,
			)
			.toArray();

		return this.jsonResponse({
			issueId: eventRows[0].issue_id,
			attachments: rows.map((row) => ({
				id: row.id as string,
				eventId: row.event_id as string,
				filename: row.filename as string,
				contentType: (row.content_type as string) ?? 'text/plain',
				size: row.size as number,
				createdAt: row.created_at as string,
			})),
		});
	}

	/** One attachment (metadata + payload location), for the download route. */
	private async handleGetAttachment(request: Request): Promise<Response> {
		const { attachmentId, eventId } = (await request.json()) as {
			attachmentId?: string;
			eventId?: string;
		};

		if (!attachmentId) {
			return this.jsonResponse({ error: 'missing_attachment_id' }, 400);
		}

		// `.one()` throws on zero rows; a missing attachment is a 404, not a 500
		const rows = this.sql
			.exec(
				`SELECT id, event_id, filename, content_type, size, data, created_at, storage, r2_key
				 FROM attachments WHERE id = ?`,
				attachmentId,
			)
			.toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'attachment_not_found' }, 404);
		}

		const row = rows[0];
		// Event-scoped access (Sentry /api/0 surface): an attachment that
		// exists but belongs to a different event is "not found" under the
		// requested event. Native callers omit `eventId` and are unaffected.
		if (eventId && (row.event_id as string) !== eventId) {
			return this.jsonResponse({ error: 'attachment_not_found' }, 404);
		}
		const storage = (row.storage as string) ?? 'inline';
		const isR2 = storage === 'r2' && typeof row.r2_key === 'string';
		return this.jsonResponse({
			attachment: {
				id: row.id as string,
				eventId: row.event_id as string,
				filename: row.filename as string,
				contentType: (row.content_type as string) ?? 'text/plain',
				size: row.size as number,
				createdAt: row.created_at as string,
				// Dual-read: inline rows serve their stored payload (online,
				// restartable migration); R2 rows point at the bucket.
				...(isR2
					? { storage: 'r2' as const, r2Key: row.r2_key as string }
					: { storage: 'inline' as const, data: (row.data as string) ?? '' }),
			},
		});
	}

	private async handleGetLatestEvents(request: Request): Promise<Response> {
		const { limit } = (await request.json()) as { limit?: number };

		const pageLimit = clampLimit(limit, 25);

		const rows = this.sql
			.exec('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?', pageLimit)
			.toArray();

		const events = rows.map((row) => ({
			...JSON.parse(row.data as string),
			issueId: row.issue_id,
		}));

		return this.jsonResponse({ events });
	}

	private async handleGetStats(request: Request): Promise<Response> {
		const { interval, start, end } = (await request.json()) as {
			interval?: '1h' | '1d' | '1w';
			start?: string;
			end?: string;
		};

		const endDate = end ? new Date(end) : new Date();
		const startDate = start
			? new Date(start)
			: new Date(
					endDate.getTime() -
						(interval === '1w' ? 7 : interval === '1d' ? 1 : 1) * 24 * 60 * 60 * 1000,
				);

		// Aggregate stats by bucket
		const rows = this.sql
			.exec(
				`SELECT bucket, SUM(count) as count
       FROM issue_stats
       WHERE bucket >= ? AND bucket <= ?
       GROUP BY bucket
       ORDER BY bucket ASC`,
				startDate.toISOString(),
				endDate.toISOString(),
			)
			.toArray();

		const series = rows.map((row) => ({
			bucket: row.bucket as string,
			count: row.count as number,
		}));

		const total = series.reduce((sum, s) => sum + s.count, 0);

		return this.jsonResponse({ total, series });
	}

	private async handleGetTags(request: Request): Promise<Response> {
		const { limit } = (await request.json()) as { limit?: number };
		const facetLimit = clampLimit(limit, 10, 50);

		const keys = this.sql
			.exec(
				`SELECT key, COUNT(DISTINCT issue_id) as issue_count, COUNT(*) as event_count
				 FROM event_tags
				 GROUP BY key
				 ORDER BY issue_count DESC
				 LIMIT ?`,
				facetLimit,
			)
			.toArray();

		const facets = keys.map((row) => {
			const topValues = this.sql
				.exec(
					`SELECT value, COUNT(DISTINCT issue_id) as issue_count, COUNT(*) as event_count
					 FROM event_tags
					 WHERE key = ?
					 GROUP BY value
					 ORDER BY issue_count DESC
					 LIMIT 10`,
					row.key as string,
				)
				.toArray();

			return {
				key: row.key as string,
				issueCount: row.issue_count as number,
				eventCount: row.event_count as number,
				topValues: topValues.map((v) => ({
					value: v.value as string,
					issueCount: v.issue_count as number,
					eventCount: v.event_count as number,
				})),
			};
		});

		return this.jsonResponse({ facets });
	}

	private async handleGetTagValues(request: Request): Promise<Response> {
		const { key, query, limit } = (await request.json()) as {
			key: string;
			query?: string;
			limit?: number;
		};

		if (!key) {
			return this.jsonResponse({ error: 'missing_key' }, 400);
		}

		const pageLimit = clampLimit(limit, 25);

		let sql = `SELECT value, COUNT(DISTINCT issue_id) as issue_count, COUNT(*) as event_count
			FROM event_tags
			WHERE key = ?`;
		const params: (string | number)[] = [key];

		if (query) {
			sql += " AND value LIKE ? ESCAPE '\\'";
			const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
			params.push(`%${escaped}%`);
		}

		sql += ' GROUP BY value ORDER BY issue_count DESC LIMIT ?';
		params.push(pageLimit);

		const rows = this.sql.exec(sql, ...params).toArray();
		const values = rows.map((row) => ({
			value: row.value as string,
			issueCount: row.issue_count as number,
			eventCount: row.event_count as number,
		}));

		return this.jsonResponse({ key, values });
	}

	private async handleGetReleases(request: Request): Promise<Response> {
		const { cursor, limit } = (await request.json()) as {
			cursor?: string;
			limit?: number;
		};

		const pageLimit = clampLimit(limit, 25);
		const params: (string | number)[] = [];

		let sql = 'SELECT * FROM releases WHERE 1=1';

		if (cursor) {
			sql += ' AND last_seen < ?';
			params.push(cursor);
		}

		sql += ' ORDER BY last_seen DESC LIMIT ?';
		params.push(pageLimit + 1);

		const rows = this.sql.exec(sql, ...params).toArray();
		const hasMore = rows.length > pageLimit;
		const releases = rows.slice(0, pageLimit).map((row) => ({
			version: row.version as string,
			firstSeen: row.first_seen as string,
			lastSeen: row.last_seen as string,
			eventCount: row.event_count as number,
			issueCount: row.issue_count as number,
			newIssueCount: row.new_issue_count as number,
		}));

		const nextCursor =
			hasMore && releases.length > 0 ? releases[releases.length - 1].lastSeen : undefined;

		return this.jsonResponse({ releases, nextCursor, hasMore });
	}

	private async handleGetRelease(request: Request): Promise<Response> {
		const { version } = (await request.json()) as { version: string };

		const releaseRows = this.sql
			.exec('SELECT * FROM releases WHERE version = ?', version)
			.toArray();

		if (releaseRows.length === 0) {
			return this.jsonResponse({ error: 'release_not_found' }, 404);
		}

		const row = releaseRows[0];
		const release = {
			version: row.version as string,
			firstSeen: row.first_seen as string,
			lastSeen: row.last_seen as string,
			eventCount: row.event_count as number,
			issueCount: row.issue_count as number,
			newIssueCount: row.new_issue_count as number,
		};

		// Get issues for this release
		const issueRows = this.sql
			.exec(
				`SELECT i.*, ri.first_seen_in_release, ri.event_count as release_event_count
				 FROM release_issues ri
				 JOIN issues i ON i.id = ri.issue_id
				 WHERE ri.release_version = ?
				 ORDER BY ri.event_count DESC
				 LIMIT 100`,
				version,
			)
			.toArray();

		const issues = issueRows.map((r) => ({
			...this.rowToIssue(r),
			firstSeenInRelease: r.first_seen_in_release as string,
			releaseEventCount: r.release_event_count as number,
		}));

		return this.jsonResponse({ release, issues });
	}

	private handleGetEnvironments(): Response {
		const rows = this.sql
			.exec(
				`SELECT environment, COUNT(DISTINCT issue_id) as issue_count, MAX(last_seen) as last_seen
			 FROM issue_environments
			 GROUP BY environment
			 ORDER BY last_seen DESC`,
			)
			.toArray();

		const environments = rows.map((row) => ({
			name: row.environment as string,
			issueCount: row.issue_count as number,
			lastSeen: row.last_seen as string,
		}));

		return this.jsonResponse({ environments });
	}

	private async handleGetSummary(): Promise<Response> {
		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
		const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

		// Issue counts by status
		const statusCounts = this.sql
			.exec('SELECT status, COUNT(*) as count FROM issues GROUP BY status')
			.toArray();

		const issuesByStatus: Record<string, number> = {};
		for (const row of statusCounts) {
			issuesByStatus[row.status as string] = row.count as number;
		}

		// Event counts for 24h and 7d
		const events24h = this.sql
			.exec('SELECT COUNT(*) as count FROM events WHERE received_at >= ?', oneDayAgo)
			.one();
		const events7d = this.sql
			.exec('SELECT COUNT(*) as count FROM events WHERE received_at >= ?', sevenDaysAgo)
			.one();

		// Error trend: hourly buckets for last 7 days
		const trendRows = this.sql
			.exec(
				`SELECT bucket, SUM(count) as count FROM issue_stats
				 WHERE bucket >= ? GROUP BY bucket ORDER BY bucket ASC`,
				sevenDaysAgo,
			)
			.toArray();

		const trend = trendRows.map((row) => ({
			bucket: row.bucket as string,
			count: row.count as number,
		}));

		// Top 5 most active unresolved issues
		const topIssueRows = this.sql
			.exec(
				`SELECT * FROM issues WHERE status = 'unresolved'
				 ORDER BY issues.count DESC LIMIT 5`,
			)
			.toArray();

		const topIssues = topIssueRows.map((row) => this.rowToIssue(row));

		// Total unique users affected
		const userCountRow = this.sql
			.exec('SELECT COUNT(DISTINCT user_hash) as count FROM issue_users')
			.one();

		return this.jsonResponse({
			issuesByStatus,
			events24h: (events24h?.count as number) || 0,
			events7d: (events7d?.count as number) || 0,
			trend,
			topIssues,
			totalUsers: (userCountRow?.count as number) || 0,
		});
	}

	private async handleGetComments(request: Request): Promise<Response> {
		const { issueId } = (await request.json()) as { issueId: string };

		const rows = this.sql
			.exec('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC', issueId)
			.toArray();

		const comments = rows.map((row) => ({
			id: row.id as string,
			issueId: row.issue_id as string,
			userId: row.user_id as string,
			userName: row.user_name as string,
			body: row.body as string,
			createdAt: row.created_at as string,
		}));

		return this.jsonResponse({ comments });
	}

	private async handleAddComment(request: Request): Promise<Response> {
		const { issueId, userId, userName, body } = (await request.json()) as {
			issueId: string;
			userId: string;
			userName: string;
			body: string;
		};

		if (!body || body.trim().length === 0) {
			return this.jsonResponse({ error: 'comment_body_required' }, 400);
		}

		if (body.length > 2000) {
			return this.jsonResponse({ error: 'comment_body_too_long' }, 400);
		}

		const commentId = crypto.randomUUID();
		const now = new Date().toISOString();

		this.sql.exec(
			`INSERT INTO issue_comments (id, issue_id, user_id, user_name, body, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			commentId,
			issueId,
			userId,
			userName,
			body.trim(),
			now,
		);

		// Also record activity
		const activityId = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO issue_activity (id, issue_id, user_id, user_name, type, data, created_at)
			 VALUES (?, ?, ?, ?, 'comment', ?, ?)`,
			activityId,
			issueId,
			userId,
			userName,
			JSON.stringify({ commentId, body: body.trim() }),
			now,
		);

		const comment = {
			id: commentId,
			issueId,
			userId,
			userName,
			body: body.trim(),
			createdAt: now,
		};

		return this.jsonResponse({ comment }, 201);
	}

	private async handleDeleteComment(request: Request): Promise<Response> {
		const { commentId, userId, issueId } = (await request.json()) as {
			commentId: string;
			userId: string;
			issueId: string;
		};

		const rows = this.sql.exec('SELECT * FROM issue_comments WHERE id = ?', commentId).toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'comment_not_found' }, 404);
		}

		const comment = rows[0];
		if (comment.user_id !== userId) {
			return this.jsonResponse({ error: 'forbidden' }, 403);
		}

		this.sql.exec('DELETE FROM issue_comments WHERE id = ?', commentId);

		// Delete corresponding activity entry, scoped by issue_id for efficiency
		const commentIssueId = issueId || (comment.issue_id as string);
		this.sql.exec(
			`DELETE FROM issue_activity WHERE type = 'comment' AND issue_id = ? AND json_extract(data, '$.commentId') = ?`,
			commentIssueId,
			commentId,
		);

		return this.jsonResponse({ success: true });
	}

	private async handleGetActivity(request: Request): Promise<Response> {
		const { issueId, cursor, limit } = (await request.json()) as {
			issueId: string;
			cursor?: string;
			limit?: number;
		};

		const pageLimit = clampLimit(limit, 50);

		let sql = 'SELECT * FROM issue_activity WHERE issue_id = ?';
		const params: (string | number)[] = [issueId];

		if (cursor) {
			// Composite cursor: "created_at|id" to avoid skipping entries with same timestamp
			const [cursorTime, cursorId] = cursor.split('|');
			sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
			params.push(cursorTime, cursorTime, cursorId);
		}

		sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
		params.push(pageLimit + 1);

		const rows = this.sql.exec(sql, ...params).toArray();
		const hasMore = rows.length > pageLimit;

		const activity = rows.slice(0, pageLimit).map((row) => ({
			id: row.id as string,
			issueId: row.issue_id as string,
			userId: row.user_id as string,
			userName: row.user_name as string,
			type: row.type as string,
			data: JSON.parse((row.data as string) || '{}'),
			createdAt: row.created_at as string,
		}));

		const lastEntry = activity.length > 0 ? activity[activity.length - 1] : undefined;
		const nextCursor = hasMore && lastEntry ? `${lastEntry.createdAt}|${lastEntry.id}` : undefined;

		return this.jsonResponse({ activity, nextCursor, hasMore });
	}

	/**
	 * Schedule the next alarm as the earliest of: one hour from now (hourly
	 * GC cadence, independent of retention settings), the next retention
	 * candidate, the earliest pending snooze expiry, a purge-sweep retry,
	 * and any alarm that is already scheduled (an earlier existing alarm is
	 * never delayed). Clamped to the future.
	 */
	private async scheduleNextAlarm(): Promise<void> {
		const now = Date.now();
		const candidates: number[] = [now + ALARM_INTERVAL_MS];

		// Consider retention schedule if enabled
		const retentionDays = this.getRetentionDays();
		if (retentionDays > 0) {
			candidates.push(now + MS_PER_DAY);
		}

		// Consider earliest pending snooze expiry
		const rows = this.sql
			.exec(
				'SELECT MIN(snoozed_until) as next FROM issues WHERE snoozed_until IS NOT NULL AND snoozed_until > ?',
				new Date().toISOString(),
			)
			.toArray();

		const next = rows[0]?.next as string | null;
		if (next) {
			candidates.push(new Date(next).getTime());
		}

		// A purge sweep that could not complete retries soon
		if (this.getConfigValue('purge_pending') === '1') {
			candidates.push(now + PURGE_RETRY_MS);
		}

		// Never delay an earlier already-scheduled alarm
		const current = await this.ctx.storage.getAlarm();
		if (current !== null && current > now) {
			candidates.push(current);
		}

		const target = Math.min(...candidates);
		await this.ctx.storage.setAlarm(Math.max(now + 1000, target));
	}

	private async handleSnoozeIssue(request: Request): Promise<Response> {
		const { issueId, duration } = (await request.json()) as {
			issueId: string;
			duration: string;
		};

		if (!issueId || !duration) {
			return this.jsonResponse({ error: 'missing_parameters' }, 400);
		}

		const rows = this.sql.exec('SELECT id FROM issues WHERE id = ?', issueId).toArray();
		if (rows.length === 0) {
			return this.jsonResponse({ error: 'issue_not_found' }, 404);
		}

		this.sql.exec('UPDATE issues SET snoozed_until = ? WHERE id = ?', duration, issueId);

		await this.scheduleNextAlarm();

		const row = this.sql.exec('SELECT * FROM issues WHERE id = ?', issueId).one();
		return this.jsonResponse({ issue: row ? this.rowToIssue(row) : null });
	}

	private async handleUnsnoozeIssue(request: Request): Promise<Response> {
		const { issueId } = (await request.json()) as { issueId: string };

		if (!issueId) {
			return this.jsonResponse({ error: 'missing_issue_id' }, 400);
		}

		const rows = this.sql.exec('SELECT id FROM issues WHERE id = ?', issueId).toArray();
		if (rows.length === 0) {
			return this.jsonResponse({ error: 'issue_not_found' }, 404);
		}

		this.sql.exec('UPDATE issues SET snoozed_until = NULL WHERE id = ?', issueId);

		const row = this.sql.exec('SELECT * FROM issues WHERE id = ?', issueId).one();
		return this.jsonResponse({ issue: row ? this.rowToIssue(row) : null });
	}

	private static readonly VALID_FILTER_TYPES = new Set([
		'message',
		'error_type',
		'ip_address',
		'release',
		'environment',
	]);

	private shouldFilterEvent(
		event: SentryEvent,
		filters: Array<Record<string, SqlStorageValue>>,
	): string | null {
		for (const filter of filters) {
			const filterType = filter.filter_type as string;
			const pattern = (filter.pattern as string).toLowerCase();
			let matched = false;

			switch (filterType) {
				case 'message': {
					const message = (
						event.exception?.values?.[0]?.value ||
						event.message ||
						''
					).toLowerCase();
					matched = message.includes(pattern);
					break;
				}
				case 'error_type': {
					const type = (event.exception?.values?.[0]?.type || '').toLowerCase();
					matched = type.includes(pattern);
					break;
				}
				case 'ip_address': {
					matched = event.user?.ip_address === filter.pattern;
					break;
				}
				case 'release': {
					matched = (event.release || '') === filter.pattern;
					break;
				}
				case 'environment': {
					matched = (event.environment || '').toLowerCase() === pattern;
					break;
				}
			}

			if (matched) {
				return filter.id as string;
			}
		}
		return null;
	}

	private handleGetFilters(): Response {
		const rows = this.sql.exec('SELECT * FROM inbound_filters ORDER BY created_at DESC').toArray();
		const filters = rows.map((row) => this.rowToFilter(row));
		return this.jsonResponse({ filters });
	}

	private async handleCreateFilter(request: Request): Promise<Response> {
		const { filterType, pattern, description } = (await request.json()) as {
			filterType: string;
			pattern: string;
			description?: string;
		};

		if (!filterType || !ProjectState.VALID_FILTER_TYPES.has(filterType)) {
			return this.jsonResponse(
				{ error: 'invalid_filter_type', message: 'Invalid filter type' },
				400,
			);
		}

		if (!pattern || pattern.length === 0 || pattern.length > 500) {
			return this.jsonResponse(
				{ error: 'invalid_pattern', message: 'Pattern must be 1-500 characters' },
				400,
			);
		}

		// Enforce a limit of 100 filters per project
		const countRow = this.sql.exec('SELECT COUNT(*) as cnt FROM inbound_filters').one();
		if (countRow && (countRow.cnt as number) >= 100) {
			return this.jsonResponse(
				{ error: 'limit_reached', message: 'Maximum of 100 filters per project' },
				400,
			);
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		this.sql.exec(
			`INSERT INTO inbound_filters (id, filter_type, pattern, enabled, description, dropped_count, created_at)
			 VALUES (?, ?, ?, 1, ?, 0, ?)`,
			id,
			filterType,
			pattern,
			description || null,
			now,
		);

		const row = this.sql.exec('SELECT * FROM inbound_filters WHERE id = ?', id).one();
		return this.jsonResponse({ filter: row ? this.rowToFilter(row) : null }, 201);
	}

	private async handleUpdateFilter(request: Request): Promise<Response> {
		const { filterId, enabled, pattern, description } = (await request.json()) as {
			filterId: string;
			enabled?: boolean;
			pattern?: string;
			description?: string | null;
		};

		if (!filterId) {
			return this.jsonResponse({ error: 'missing_filter_id' }, 400);
		}

		// Check filter exists
		const existing = this.sql
			.exec('SELECT id FROM inbound_filters WHERE id = ?', filterId)
			.toArray();
		if (existing.length === 0) {
			return this.jsonResponse({ error: 'filter_not_found' }, 404);
		}

		const updates: string[] = [];
		const params: (string | number | null)[] = [];

		if (enabled !== undefined) {
			updates.push('enabled = ?');
			params.push(enabled ? 1 : 0);
		}

		if (pattern !== undefined) {
			if (pattern.length === 0 || pattern.length > 500) {
				return this.jsonResponse(
					{ error: 'invalid_pattern', message: 'Pattern must be 1-500 characters' },
					400,
				);
			}
			updates.push('pattern = ?');
			params.push(pattern);
		}

		if (description !== undefined) {
			updates.push('description = ?');
			params.push(description);
		}

		if (updates.length === 0) {
			return this.jsonResponse({ error: 'no_updates' }, 400);
		}

		params.push(filterId);
		this.sql.exec(`UPDATE inbound_filters SET ${updates.join(', ')} WHERE id = ?`, ...params);

		const row = this.sql.exec('SELECT * FROM inbound_filters WHERE id = ?', filterId).one();
		return this.jsonResponse({ filter: row ? this.rowToFilter(row) : null });
	}

	private async handleDeleteFilter(request: Request): Promise<Response> {
		const { filterId } = (await request.json()) as { filterId: string };

		if (!filterId) {
			return this.jsonResponse({ error: 'missing_filter_id' }, 400);
		}

		// Check filter exists
		const existing = this.sql
			.exec('SELECT id FROM inbound_filters WHERE id = ?', filterId)
			.toArray();
		if (existing.length === 0) {
			return this.jsonResponse({ error: 'filter_not_found' }, 404);
		}

		this.sql.exec('DELETE FROM inbound_filters WHERE id = ?', filterId);
		return this.jsonResponse({ success: true });
	}

	private rowToFilter(row: Record<string, SqlStorageValue>): InboundFilter {
		return {
			id: row.id as string,
			filterType: row.filter_type as FilterType,
			pattern: row.pattern as string,
			enabled: (row.enabled as number) === 1,
			description: row.description as string | null,
			droppedCount: row.dropped_count as number,
			createdAt: row.created_at as string,
		};
	}

	private getHourBucket(timestamp: string): string {
		const date = new Date(timestamp);
		date.setMinutes(0, 0, 0);
		return date.toISOString();
	}

	private async hashUserIdentifier(user: SentryEvent['user']): Promise<string | null> {
		if (!user) return null;

		const identifier = user.id || user.email || user.ip_address || user.username;
		if (!identifier) return null;

		const encoder = new TextEncoder();
		const data = encoder.encode(identifier);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 32);
	}

	private rowToIssue(row: Record<string, SqlStorageValue>): Issue {
		return {
			id: row.id as string,
			fingerprint: row.fingerprint as string,
			title: row.title as string,
			culprit: row.culprit as string | null,
			level: row.level as Issue['level'],
			platform: row.platform as string,
			firstSeen: row.first_seen as string,
			lastSeen: row.last_seen as string,
			count: row.count as number,
			userCount: row.user_count as number,
			status: row.status as Issue['status'],
			snoozedUntil: (row.snoozed_until as string) || null,
			metadata: JSON.parse((row.metadata as string) || '{}'),
		};
	}

	private warmRateLimitCounter(): void {
		const bucket = this.getHourBucket(new Date().toISOString());
		this.rateLimitBucket = bucket;
		// Check persisted counter first
		const row = this.sql
			.exec('SELECT count FROM rate_limit_counters WHERE bucket = ?', bucket)
			.toArray();
		if (row.length > 0) {
			this.rateLimitCount = row[0].count as number;
		} else {
			// Fallback: sum from issue_stats for this hour
			const statsRow = this.sql
				.exec('SELECT COALESCE(SUM(count), 0) as total FROM issue_stats WHERE bucket = ?', bucket)
				.one();
			this.rateLimitCount = (statsRow?.total as number) || 0;
		}
	}

	/**
	 * Recompute the in-memory rate-limit cache from the persisted counter.
	 * Called only after the ingest transaction commits, so a rollback leaves
	 * both the persisted counter and the cache untouched.
	 */
	private refreshRateLimitCount(): void {
		const bucket = this.getHourBucket(new Date().toISOString());
		const row = this.sql
			.exec('SELECT count FROM rate_limit_counters WHERE bucket = ?', bucket)
			.toArray();
		this.rateLimitBucket = bucket;
		this.rateLimitCount = row.length > 0 ? (row[0].count as number) : 0;
	}

	private checkRateLimit(): { allowed: boolean; retryAfter?: number } {
		const maxPerHour = this.getConfigValue('max_events_per_hour');
		if (!maxPerHour || maxPerHour === '0') {
			return { allowed: true };
		}
		const limit = Number.parseInt(maxPerHour, 10);
		if (limit <= 0) return { allowed: true };

		if (this.currentRateCount() >= limit) {
			return { allowed: false, retryAfter: this.retryAfterSeconds() };
		}
		return { allowed: true };
	}

	/**
	 * Current-hour event count. Read-only: the in-memory cache is consulted
	 * only when it belongs to the current hour; on rollover (or before the
	 * first refresh) the persisted counter is read instead. Mutating the
	 * cache or deleting old buckets happens inside the ingest transaction.
	 */
	private currentRateCount(): number {
		const bucket = this.getHourBucket(new Date().toISOString());
		if (bucket === this.rateLimitBucket) {
			return this.rateLimitCount;
		}
		const row = this.sql
			.exec('SELECT count FROM rate_limit_counters WHERE bucket = ?', bucket)
			.toArray();
		return row.length > 0 ? (row[0].count as number) : 0;
	}

	/** Seconds until the top of the current hour (rate-limit retry hint). */
	private retryAfterSeconds(): number {
		const now = new Date();
		const nextHour = new Date(now);
		nextHour.setMinutes(0, 0, 0);
		nextHour.setHours(nextHour.getHours() + 1);
		return Math.ceil((nextHour.getTime() - now.getTime()) / 1000);
	}

	private getConfigValue(key: string): string | null {
		const rows = this.sql.exec('SELECT value FROM project_config WHERE key = ?', key).toArray();
		return rows.length > 0 ? (rows[0].value as string) : null;
	}

	private setConfigValue(key: string, value: string): void {
		this.sql.exec(
			'INSERT INTO project_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
			key,
			value,
			value,
		);
	}

	private handleGetConfig(): Response {
		const maxEventsPerHour = this.getConfigValue('max_events_per_hour') || '0';
		const maxAttachmentBytes =
			Number.parseInt(this.getConfigValue('max_attachment_total_bytes') || '', 10) ||
			MAX_PROJECT_ATTACHMENT_BYTES;
		return this.jsonResponse({
			config: {
				maxEventsPerHour: Number.parseInt(maxEventsPerHour, 10),
				maxAttachmentBytes,
			},
		});
	}

	private async handleUpdateConfig(request: Request): Promise<Response> {
		const { maxEventsPerHour, maxAttachmentBytes } = (await request.json()) as {
			maxEventsPerHour?: number;
			maxAttachmentBytes?: number;
		};
		if (maxEventsPerHour !== undefined) {
			if (typeof maxEventsPerHour !== 'number' || maxEventsPerHour < 0) {
				return this.jsonResponse(
					{ error: 'invalid_value', message: 'maxEventsPerHour must be a non-negative number' },
					400,
				);
			}
			this.setConfigValue('max_events_per_hour', String(Math.floor(maxEventsPerHour)));
		}
		if (maxAttachmentBytes !== undefined) {
			if (
				typeof maxAttachmentBytes !== 'number' ||
				!Number.isInteger(maxAttachmentBytes) ||
				maxAttachmentBytes <= 0
			) {
				return this.jsonResponse(
					{
						error: 'invalid_value',
						message: 'maxAttachmentBytes must be a positive integer',
					},
					400,
				);
			}
			this.setConfigValue('max_attachment_total_bytes', String(maxAttachmentBytes));
		}
		return this.handleGetConfig();
	}

	/** True when the project's hourly event quota is exhausted. */
	private isRateLimited(): boolean {
		const maxPerHour = Number.parseInt(this.getConfigValue('max_events_per_hour') || '0', 10);
		return maxPerHour > 0 && this.currentRateCount() >= maxPerHour;
	}

	private handleRateLimitStatus(): Response {
		const maxPerHour = Number.parseInt(this.getConfigValue('max_events_per_hour') || '0', 10);
		const currentBucket = this.getHourBucket(new Date().toISOString());
		const currentCount = this.currentRateCount();
		return this.jsonResponse({
			maxEventsPerHour: maxPerHour,
			currentHourCount: currentCount,
			currentBucket,
			isLimited: maxPerHour > 0 && currentCount >= maxPerHour,
		});
	}

	/**
	 * Alarm entry point. The body runs inside a try/finally so an exception
	 * mid-alarm (e.g. a transient R2 failure during migration) never leaves
	 * the DO without a future alarm: GC/migration/purge-retry would stall
	 * until the next fetch otherwise. A wiped DO is NOT rescheduled
	 * (deleteAll cancelled its alarms; the state is gone).
	 */
	async alarm(): Promise<void> {
		let wiped = false;
		try {
			wiped = await this.runAlarmWork();
		} finally {
			if (!wiped) {
				await this.scheduleNextAlarm().catch(() => {});
			}
		}
	}

	private async runAlarmWork(): Promise<boolean> {
		await this.ensureSchema();

		// A purge that could not finish its R2 sweep resumes here; while it
		// is pending, no other maintenance runs (the state is going away).
		if (this.getConfigValue('purge_pending') === '1') {
			const complete = await this.runPurgeSweep(false);
			if (!complete) {
				return false; // the alarm wrapper reschedules the retry
			}
			await this.ctx.storage.deleteAll();
			this.initialized = false;
			return true; // wiped: do not reschedule
		}

		const now = new Date().toISOString();

		// Un-snooze all issues whose snooze has expired
		this.sql.exec(
			'UPDATE issues SET snoozed_until = NULL WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?',
			now,
		);

		// Handle data retention if enabled
		const retentionDays = this.getRetentionDays();
		if (retentionDays > 0) {
			const cutoffDate = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();

			// Attachment blobs of the events being deleted are collected
			// BEFORE the cascade, inside the same transaction as the row
			// deletes and the usage decrement.
			const doomedRows = this.sql
				.exec(
					`SELECT r2_key FROM attachments
					 WHERE storage = 'r2' AND r2_key IS NOT NULL
					   AND event_id IN (SELECT id FROM events WHERE received_at < ?)`,
					cutoffDate,
				)
				.toArray();
			const totalBytes = this.sumAttachmentBytes(
				this.sql
					.exec(
						`SELECT COALESCE(SUM(size), 0) AS total FROM attachments
						 WHERE event_id IN (SELECT id FROM events WHERE received_at < ?)`,
						cutoffDate,
					)
					.toArray(),
			);

			this.ctx.storage.transactionSync(() => {
				// Seed BEFORE the deletes (see handleDeleteIssue)
				this.seedAttachmentUsage();

				// Delete old events (attachment rows cascade)
				this.sql.exec('DELETE FROM events WHERE received_at < ?', cutoffDate);

				// Delete old issue_stats buckets
				this.sql.exec('DELETE FROM issue_stats WHERE bucket < ?', cutoffDate);

				// Clean up issue_users whose last activity is before the cutoff
				this.sql.exec('DELETE FROM issue_users WHERE last_seen < ?', cutoffDate);

				// Recalculate issue counts from remaining events
				this.sql.exec(`
					UPDATE issues SET count = (
						SELECT COUNT(*) FROM events WHERE events.issue_id = issues.id
					)
				`);

				// Recalculate user counts from remaining issue_users
				this.sql.exec(`
					UPDATE issues SET user_count = (
						SELECT COUNT(*) FROM issue_users WHERE issue_users.issue_id = issues.id
					)
				`);

				// Delete issues with no remaining events
				this.sql.exec('DELETE FROM issues WHERE count = 0');

				// Clean up orphaned issue_users for deleted issues
				this.sql.exec('DELETE FROM issue_users WHERE issue_id NOT IN (SELECT id FROM issues)');

				this.sql.exec(
					'UPDATE attachment_usage SET bytes = MAX(0, bytes - ?) WHERE id = 1',
					totalBytes,
				);
			});

			await this.deleteAttachmentBlobs(doomedRows.map((row) => row.r2_key as string));
		}

		// Correct usage-counter drift from SUM(size) at most once per day
		this.maybeRecomputeAttachmentUsage();

		// Reclaim orphaned blobs (uploaded but never committed by any row)
		const gcRemoved = await this.runGcSweep();

		// Migrate legacy inline attachment payloads to R2 (online, restartable)
		const migrated = await this.migrateInlineAttachments();

		// One summary line per alarm run: this path has no API surface, so
		// the log is the only way to see GC/migration liveness in production.
		const projectId = this.getProjectId();
		const inlineRows = projectId
			? (this.sql
					.exec(
						`SELECT COUNT(*) AS n,
						        COALESCE(SUM(storage IS NOT 'r2' AND data != ''), 0) AS eligible
						 FROM attachments`,
					)
					.one() as { n: number; eligible: number } | undefined)
			: undefined;
		console.log(
			`ProjectState alarm: gcRemoved=${gcRemoved} migratedInline=${migrated}` +
				(retentionDays > 0 ? ' retention=ran' : '') +
				` projectId=${projectId ? 'set' : 'MISSING'}` +
				(inlineRows ? ` attachmentRows=${inlineRows.n} eligibleInline=${inlineRows.eligible}` : ''),
		);

		// The alarm wrapper reschedules (earliest of next retention run,
		// next snooze expiry, or the hourly GC cadence floor)
		return false;
	}

	/**
	 * Recompute the usage counter from `SUM(size)` at most once per alarm-day
	 * (gated by a `project_config` timestamp) to correct drift.
	 */
	private maybeRecomputeAttachmentUsage(): void {
		const last = Number(this.getConfigValue('attachment_usage_recomputed_at') || '0');
		const now = Date.now();
		if (Number.isFinite(last) && now - last < MS_PER_DAY) {
			return;
		}
		this.setConfigValue('attachment_usage_recomputed_at', String(now));
		this.seedAttachmentUsage();
		this.sql.exec(
			'UPDATE attachment_usage SET bytes = (SELECT COALESCE(SUM(size), 0) FROM attachments) WHERE id = 1',
		);
	}

	/**
	 * GC (orphan sweep): list the project prefix page by page (continuation
	 * cursor persisted across runs, so the whole prefix is scanned over
	 * multiple hourly runs regardless of live object count), deleting objects
	 * past the 1-hour grace whose key has no `attachments.r2_key` match
	 * (indexed point lookup). Bounded per run by max 10,000 objects or a
	 * 30-second time budget, whichever comes first. The reclaim window for a
	 * fresh orphan therefore scales with live object count (~10k objects per
	 * hour): roughly 4 hours at ~40k live objects, 1–2 days near the 10 GiB
	 * budget with ~100 KiB blobs.
	 */
	private async runGcSweep(): Promise<number> {
		const projectId = this.getProjectId();
		if (!projectId) return 0; // no prefix can exist without a persisted id

		const store = createAttachmentStore(this.env, null);
		const prefix = projectPrefix(projectId);
		const deadline = Date.now() + GC_TIME_BUDGET_MS;
		const now = Date.now();
		let cursor: string | null = this.getConfigValue('gc_cursor') || null;
		let scanned = 0;
		const doomed: string[] = [];

		try {
			for (;;) {
				const page = await store.listPage(prefix, cursor);
				scanned += page.objects.length;
				for (const object of page.objects) {
					if (now - object.uploaded.getTime() <= GC_GRACE_MS) continue;
					const referenced = this.sql
						.exec('SELECT 1 FROM attachments WHERE r2_key = ?', object.key)
						.toArray();
					if (referenced.length === 0) {
						doomed.push(object.key);
					}
				}
				cursor = page.cursor;
				if (!cursor || scanned >= GC_MAX_OBJECTS || Date.now() > deadline) break;
			}
			this.setConfigValue('gc_cursor', cursor ?? '');
		} catch (error) {
			// Cursor stays persisted for the next run
			console.error(
				'GC sweep incomplete; will resume:',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
		}

		if (doomed.length > 0) {
			await this.deleteAttachmentBlobs(doomed);
		}
		return doomed.length;
	}

	/**
	 * Migrate legacy inline attachment payloads to R2: upload each row's
	 * `data` to its deterministic `m/{attachmentId}` key, then flip
	 * conditionally — zero rows changed means the row was deleted mid-flight
	 * (a fetch can interleave during the upload await), so the just-uploaded
	 * blob is deleted. Reads dual-read meanwhile, so migration is online and
	 * restartable: a crash between upload and flip leaves the row inline and
	 * the next run re-uploads the same deterministic key. Byte-neutral for
	 * the usage counter.
	 */
	private async migrateInlineAttachments(): Promise<number> {
		const projectId = this.getProjectId();
		if (!projectId) return 0; // inline rows keep serving; no prefix to use

		// NULL-safe eligibility: pre-upgrade rows can carry a NULL `storage`
		// (the ADD COLUMN DEFAULT does not materialize for rows that existed
		// before the migration on real deployments) — `= 'inline'` would
		// never match them, and the flip's zero-row miss would then delete
		// the just-uploaded blob. Anything not already 'r2' with data is
		// migratable.
		const rows = this.sql
			.exec(
				`SELECT id, data FROM attachments
				 WHERE storage IS NOT 'r2' AND data != ''
				 ORDER BY rowid LIMIT ${MIGRATION_BATCH}`,
			)
			.toArray();
		if (rows.length === 0) return 0;
		let migrated = 0;

		// One-shot test fault (armed via the internal route; alarms carry no
		// headers): force the first row's flip to miss, exercising the
		// delete-during-put cleanup branch deterministically.
		let forceFlipMiss = false;
		if (this.getConfigValue('migration_flip_fault') === '1') {
			forceFlipMiss = true;
			this.setConfigValue('migration_flip_fault', '');
		}

		const store = createAttachmentStore(this.env, null);
		const encoder = new TextEncoder();
		for (const row of rows) {
			const id = row.id as string;
			const data = row.data as string;
			const key = migrationKey(projectId, id);
			await store.uploadAttachment(key, encoder.encode(data), data.length);
			let flipped = false;
			if (forceFlipMiss) {
				// Simulated delete-during-put: the row vanished between the
				// SELECT and the flip — do not touch it, just remove the
				// just-uploaded blob.
				forceFlipMiss = false;
			} else {
				const cursor = this.sql.exec(
					`UPDATE attachments SET r2_key = ?, storage = 'r2', data = ''
					 WHERE id = ? AND storage IS NOT 'r2'`,
					key,
					id,
				);
				flipped = cursor.rowsWritten > 0;
			}
			if (!flipped) {
				// Row was deleted between SELECT and flip: remove the blob.
				await this.deleteAttachmentBlobs([key]);
			} else {
				migrated++;
			}
		}
		return migrated;
	}

	private getRetentionDays(): number {
		const rows = this.sql.exec("SELECT value FROM settings WHERE key = 'retention_days'").toArray();
		return rows.length > 0 ? Number.parseInt(rows[0].value as string, 10) : 0;
	}

	private handleGetSettings(): Response {
		const retentionDays = this.getRetentionDays();
		return this.jsonResponse({ retentionDays, scrubHeaders: this.getScrubHeaders() });
	}

	/** Header names whose values are removed from stored events (case-insensitive). */
	private getScrubHeaders(): string[] {
		try {
			const rows = this.sql
				.exec("SELECT value FROM settings WHERE key = 'scrub_headers'")
				.toArray();
			if (rows.length > 0) {
				const parsed = JSON.parse(rows[0].value as string);
				if (Array.isArray(parsed)) return parsed.filter((e) => typeof e === 'string');
			}
		} catch {
			// Fall through to defaults
		}
		return [...DEFAULT_SCRUB_HEADERS];
	}

	/**
	 * Remove sensitive data from an event before persistence: configured
	 * request headers, cookies, environment variables and query-string style
	 * secrets. Applied to every stored copy of the payload.
	 */
	private redactEvent(event: SentryEvent): SentryEvent {
		const scrub = new Set(this.getScrubHeaders().map((header) => header.toLowerCase()));
		const FILTERED = '[Filtered]';

		const request = event.request as
			| {
					headers?: Record<string, string>;
					cookies?: unknown;
					env?: Record<string, string>;
					query_string?: string;
			  }
			| undefined;
		if (request) {
			if (request.headers && typeof request.headers === 'object') {
				for (const key of Object.keys(request.headers)) {
					if (scrub.has(key.toLowerCase())) {
						request.headers[key] = FILTERED;
					}
				}
			}
			if (request.cookies !== undefined) {
				request.cookies = FILTERED;
			}
			if (request.env && typeof request.env === 'object') {
				for (const key of Object.keys(request.env)) {
					request.env[key] = FILTERED;
				}
			}
			if (typeof request.query_string === 'string') {
				request.query_string = request.query_string.replace(
					/([?&])([^?&=#]*?(?:secret|token|key|password|credential)[^?&=#]*)=([^?&]*)/gi,
					'$1$2=[Filtered]',
				);
			}
		}

		// Strip credentials from structured user data
		if (event.user && typeof event.user === 'object') {
			if (event.user.ip_address) event.user.ip_address = undefined;
		}

		return event;
	}

	private async handleUpdateSettings(request: Request): Promise<Response> {
		const { retentionDays, scrubHeaders } = (await request.json()) as ProjectSettings & {
			scrubHeaders?: string[];
		};

		if (
			typeof retentionDays !== 'number' ||
			!Number.isInteger(retentionDays) ||
			retentionDays < 0
		) {
			return this.jsonResponse(
				{
					error: 'invalid_retention_days',
					message: 'retentionDays must be 0 or a positive integer',
				},
				400,
			);
		}

		if (scrubHeaders !== undefined) {
			if (
				!Array.isArray(scrubHeaders) ||
				scrubHeaders.length > 50 ||
				scrubHeaders.some((header) => typeof header !== 'string' || header.length > 100)
			) {
				return this.jsonResponse(
					{ error: 'invalid_scrub_headers', message: 'scrubHeaders must be ≤50 header names' },
					400,
				);
			}
			this.sql.exec(
				"INSERT OR REPLACE INTO settings (key, value) VALUES ('scrub_headers', ?)",
				JSON.stringify(scrubHeaders),
			);
		}

		this.sql.exec(
			"INSERT OR REPLACE INTO settings (key, value) VALUES ('retention_days', ?)",
			String(retentionDays),
		);

		// Reschedule alarm considering both retention and pending snoozes
		await this.scheduleNextAlarm();

		return this.jsonResponse({ retentionDays });
	}

	private async handleUploadSourceMap(request: Request): Promise<Response> {
		const { release, fileUrl, content } = (await request.json()) as {
			release: string;
			fileUrl: string;
			content: string;
		};

		if (!release || release.length > 200) {
			return this.jsonResponse({ error: 'invalid_release' }, 400);
		}
		if (!fileUrl || fileUrl.length > 500) {
			return this.jsonResponse({ error: 'invalid_file_url' }, 400);
		}
		if (!content || content.length > 5_242_880) {
			return this.jsonResponse({ error: 'content_too_large', maxSize: '5MB' }, 400);
		}

		try {
			JSON.parse(content);
		} catch {
			return this.jsonResponse({ error: 'invalid_source_map_json' }, 400);
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const size = new TextEncoder().encode(content).length;

		// Per-project quota: unbounded uploads are a storage-exhaustion vector
		// (upserts on the same release/fileUrl replace rather than count)
		const existing = this.sql
			.exec('SELECT id FROM source_maps WHERE release = ? AND file_url = ?', release, fileUrl)
			.toArray();
		if (existing.length === 0) {
			const countRows = this.sql.exec('SELECT COUNT(*) as count FROM source_maps').toArray();
			const count = countRows.length > 0 ? (countRows[0].count as number) : 0;
			if (count >= 200) {
				return this.jsonResponse(
					{ error: 'quota_exceeded', message: 'Source map quota (200) exceeded for this project' },
					400,
				);
			}
		}

		this.sql.exec(
			`INSERT INTO source_maps (id, release, file_url, content, created_at, size)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (release, file_url) DO UPDATE SET
			   id = excluded.id,
			   content = excluded.content,
			   created_at = excluded.created_at,
			   size = excluded.size`,
			id,
			release,
			fileUrl,
			content,
			now,
			size,
		);

		return this.jsonResponse({
			sourceMap: { id, release, fileUrl, createdAt: now, size },
		});
	}

	private async handleListSourceMaps(request: Request): Promise<Response> {
		const { release } = (await request.json()) as { release?: string };

		let sql = 'SELECT id, release, file_url, created_at, size FROM source_maps';
		const params: string[] = [];

		if (release) {
			sql += ' WHERE release = ?';
			params.push(release);
		}

		sql += ' ORDER BY release DESC, created_at DESC LIMIT 100';

		const rows = this.sql.exec(sql, ...params).toArray();
		const sourceMaps = rows.map((row) => ({
			id: row.id as string,
			release: row.release as string,
			fileUrl: row.file_url as string,
			createdAt: row.created_at as string,
			size: row.size as number,
		}));

		return this.jsonResponse({ sourceMaps });
	}

	private async handleGetSourceMap(request: Request): Promise<Response> {
		const { id, release, fileUrl } = (await request.json()) as {
			id?: string;
			release?: string;
			fileUrl?: string;
		};

		let row: Record<string, SqlStorageValue> | undefined;
		if (id) {
			row = this.sql.exec('SELECT * FROM source_maps WHERE id = ?', id).toArray()[0];
		} else if (release && fileUrl) {
			row = this.sql
				.exec('SELECT * FROM source_maps WHERE release = ? AND file_url = ?', release, fileUrl)
				.toArray()[0];
		} else {
			return this.jsonResponse({ error: 'missing_id_or_release_and_file_url' }, 400);
		}

		if (!row) {
			return this.jsonResponse({ error: 'source_map_not_found' }, 404);
		}

		return this.jsonResponse({
			sourceMap: {
				id: row.id as string,
				release: row.release as string,
				fileUrl: row.file_url as string,
				createdAt: row.created_at as string,
				size: row.size as number,
			},
			content: row.content as string,
		});
	}

	private async handleDeleteSourceMap(request: Request): Promise<Response> {
		const { id } = (await request.json()) as { id: string };

		if (!id) {
			return this.jsonResponse({ error: 'missing_id' }, 400);
		}

		this.sql.exec('DELETE FROM source_maps WHERE id = ?', id);
		return this.jsonResponse({ success: true });
	}

	private async handleMergeIssues(request: Request): Promise<Response> {
		const { primaryIssueId, issueIds } = (await request.json()) as {
			primaryIssueId: string;
			issueIds: string[];
		};

		// Bound the merge list: an unbounded array means unbounded SQL
		// statements and DO CPU time per request (bulk-update caps at 100)
		if (!Array.isArray(issueIds) || issueIds.length > 100) {
			return this.jsonResponse(
				{ error: 'invalid_issue_ids', message: 'issueIds must be an array of at most 100 ids' },
				400,
			);
		}

		// Validate primary issue exists
		const primaryRows = this.sql
			.exec('SELECT id FROM issues WHERE id = ?', primaryIssueId)
			.toArray();
		if (primaryRows.length === 0) {
			return this.jsonResponse({ error: 'primary_issue_not_found' }, 404);
		}

		// Filter out primary from merge list
		const secondaryIds = issueIds.filter((id) => id !== primaryIssueId);
		if (secondaryIds.length === 0) {
			return this.jsonResponse({ error: 'no_issues_to_merge' }, 400);
		}

		// Validate all secondary issues exist
		const placeholders = secondaryIds.map(() => '?').join(',');
		const secondaryRows = this.sql
			.exec(`SELECT id, fingerprint FROM issues WHERE id IN (${placeholders})`, ...secondaryIds)
			.toArray();

		if (secondaryRows.length !== secondaryIds.length) {
			return this.jsonResponse({ error: 'some_issues_not_found' }, 404);
		}

		// Move events from secondary issues to primary
		this.sql.exec(
			`UPDATE events SET issue_id = ? WHERE issue_id IN (${placeholders})`,
			primaryIssueId,
			...secondaryIds,
		);

		// Update event_tags to point to primary issue
		this.sql.exec(
			`UPDATE event_tags SET issue_id = ? WHERE issue_id IN (${placeholders})`,
			primaryIssueId,
			...secondaryIds,
		);

		// Merge issue_stats: add counts to primary, handling bucket conflicts
		for (const secondaryId of secondaryIds) {
			const statsRows = this.sql
				.exec('SELECT bucket, count FROM issue_stats WHERE issue_id = ?', secondaryId)
				.toArray();
			for (const stat of statsRows) {
				this.sql.exec(
					`INSERT INTO issue_stats (issue_id, bucket, count)
					 VALUES (?, ?, ?)
					 ON CONFLICT (issue_id, bucket) DO UPDATE SET count = count + excluded.count`,
					primaryIssueId,
					stat.bucket,
					stat.count,
				);
			}
		}

		// Merge issue_users: union of unique users with MIN/MAX first/last seen
		for (const secondaryId of secondaryIds) {
			const userRows = this.sql
				.exec(
					'SELECT user_hash, first_seen, last_seen FROM issue_users WHERE issue_id = ?',
					secondaryId,
				)
				.toArray();
			for (const user of userRows) {
				this.sql.exec(
					`INSERT INTO issue_users (issue_id, user_hash, first_seen, last_seen)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (issue_id, user_hash) DO UPDATE SET
					   first_seen = MIN(first_seen, excluded.first_seen),
					   last_seen = MAX(last_seen, excluded.last_seen)`,
					primaryIssueId,
					user.user_hash,
					user.first_seen,
					user.last_seen,
				);
			}
		}

		// Merge issue_environments: union with additive event counts
		for (const secondaryId of secondaryIds) {
			const envRows = this.sql
				.exec(
					'SELECT environment, first_seen, last_seen, event_count FROM issue_environments WHERE issue_id = ?',
					secondaryId,
				)
				.toArray();
			for (const env of envRows) {
				this.sql.exec(
					`INSERT INTO issue_environments (issue_id, environment, first_seen, last_seen, event_count)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT (issue_id, environment) DO UPDATE SET
					   first_seen = MIN(first_seen, excluded.first_seen),
					   last_seen = MAX(last_seen, excluded.last_seen),
					   event_count = event_count + excluded.event_count`,
					primaryIssueId,
					env.environment,
					env.first_seen,
					env.last_seen,
					env.event_count,
				);
			}
		}

		const now = new Date().toISOString();

		// Update any existing fingerprint_redirects that point to secondary issues to point to primary
		// This handles redirect chains (A→B, then B merged into C → A should redirect to C)
		this.sql.exec(
			`UPDATE fingerprint_redirects SET target_issue_id = ? WHERE target_issue_id IN (${placeholders})`,
			primaryIssueId,
			...secondaryIds,
		);

		// Create fingerprint redirects for all secondary issue fingerprints
		for (const row of secondaryRows) {
			this.sql.exec(
				`INSERT OR REPLACE INTO fingerprint_redirects (fingerprint, target_issue_id, created_at)
				 VALUES (?, ?, ?)`,
				row.fingerprint,
				primaryIssueId,
				now,
			);
		}

		// Delete secondary issues (CASCADE removes their stats, users, environments)
		this.sql.exec(`DELETE FROM issues WHERE id IN (${placeholders})`, ...secondaryIds);

		// Recalculate primary issue aggregates from actual data
		const eventCount = this.sql
			.exec('SELECT COUNT(*) as cnt FROM events WHERE issue_id = ?', primaryIssueId)
			.one();
		const userCount = this.sql
			.exec('SELECT COUNT(*) as cnt FROM issue_users WHERE issue_id = ?', primaryIssueId)
			.one();
		const firstEvent = this.sql
			.exec('SELECT MIN(timestamp) as ts FROM events WHERE issue_id = ?', primaryIssueId)
			.one();
		const lastEvent = this.sql
			.exec('SELECT MAX(timestamp) as ts FROM events WHERE issue_id = ?', primaryIssueId)
			.one();

		this.sql.exec(
			`UPDATE issues SET count = ?, user_count = ?, first_seen = COALESCE(?, first_seen), last_seen = COALESCE(?, last_seen) WHERE id = ?`,
			eventCount?.cnt ?? 0,
			userCount?.cnt ?? 0,
			firstEvent?.ts,
			lastEvent?.ts,
			primaryIssueId,
		);

		const updatedIssue = this.sql.exec('SELECT * FROM issues WHERE id = ?', primaryIssueId).one();

		return this.jsonResponse({
			issue: updatedIssue ? this.rowToIssue(updatedIssue) : null,
			mergedCount: secondaryIds.length,
		});
	}

	private jsonResponse(data: unknown, status = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}
