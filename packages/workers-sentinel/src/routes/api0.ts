import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../lib/project-access';
import type { AuthContext, Env, Project } from '../types';
import { contentDisposition, safeContentType } from './attachments';

type Variables = {
	auth?: AuthContext;
};

/**
 * Sentry `/api/0` API: agentic triage surface (issues, events, comments,
 * discovery) plus event attachments. The org path segment is accepted but
 * ignored (single tenant); the project segment resolves by slug first, then
 * by id. Attachment ids are the native opaque `{eventId}:{n}` composites,
 * passed back verbatim by clients.
 */
export const api0Routes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Error-shape translator for the /api/0 namespace: non-2xx JSON bodies shaped
 * `{error[, message]}` (the native API's error convention, including
 * authMiddleware's early 401 returns) are rewritten to Sentry's
 * `{"detail": …}` on this surface only. Must be registered BEFORE
 * authMiddleware on `/api/0/*` — registration order is wrap order in Hono, so
 * the translator's `await next()` surrounds auth's early returns; a
 * translator registered after auth would never see them.
 */
export const api0ErrorTranslator = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	await next();
	const status = c.res.status;
	if (status < 400) {
		return;
	}
	// Every path past this point replaces c.res: the original body has been
	// (or may have been) consumed, and leaving it in place would hand the
	// outer middleware a disturbed stream.
	const headers = new Headers(c.res.headers);
	let bodyText: string | null = null;
	try {
		bodyText = await c.res.text();
	} catch {
		bodyText = null;
	}
	let out: string | null = null; // null → generic detail body
	if (bodyText !== null) {
		const contentType = headers.get('Content-Type') ?? '';
		if (contentType.includes('application/json')) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(bodyText);
			} catch {
				parsed = undefined;
			}
			const candidate =
				parsed !== null && typeof parsed === 'object'
					? (parsed as { error?: unknown; message?: unknown })
					: null;
			out =
				candidate && typeof candidate.error === 'string'
					? JSON.stringify({
							detail: typeof candidate.message === 'string' ? candidate.message : candidate.error,
						})
					: bodyText; // already Sentry-shaped or not machine-generated JSON
		}
	}
	if (out === null) {
		// Unexpected failure (thrown exception → Hono's plain-text 500, an
		// unreadable body, or any other non-JSON error): keep the namespace's
		// {"detail": …} guarantee without echoing exception details.
		out = JSON.stringify({
			detail: status >= 500 ? 'internal server error' : c.res.statusText || 'error',
		});
	}
	// A rebuilt body must not carry the original's stale length.
	headers.delete('Content-Length');
	c.res = new Response(out, {
		status,
		statusText: c.res.statusText,
		headers,
	});
	return;
});

/** Row shape shared by the DO list and detail responses. */
interface CompatAttachmentRow {
	id: string;
	eventId: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: string;
}

/**
 * Sentry's event-attachment serializer shape (nine fields, `sha1` null —
 * current upstream behavior). `headers` carries only Content-Type, matching
 * what this system ever stored.
 */
function serializeAttachment(row: CompatAttachmentRow) {
	return {
		id: row.id,
		event_id: row.eventId,
		type: 'event.attachment',
		name: row.filename,
		mimetype: row.contentType,
		dateCreated: row.createdAt,
		size: row.size,
		headers: { 'Content-Type': row.contentType },
		sha1: null,
	};
}

/**
 * Resolve the `{project_id_or_slug}` segment: slug first, then (on miss) id
 * via AuthState's `alsoTryId` fallback. Both paths run under the same
 * membership gate, so non-members and cross-project callers get the same
 * null (→ uniform 404) whether they probe by slug or id.
 */
async function resolveCompatProject(c: AppContext, projectParam: string): Promise<Project | null> {
	const auth = c.get('auth');
	if (!auth) {
		return null;
	}
	const authState = c.env.AUTH_STATE.get(c.env.AUTH_STATE.idFromName('global'));
	const response = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: projectParam, userId: auth.user.id, alsoTryId: true }),
		}),
	);
	if (!response.ok) {
		return null;
	}
	const data = (await response.json()) as { project: Project };
	return data.project;
}

/**
 * Page size: valid integers clamp into 1..100; absent, non-integer, or
 * unsafe values fall back to the default of 100.
 */
function parseCompatLimit(raw: string | undefined): number {
	if (raw === undefined) {
		return 100;
	}
	if (!/^-?\d+$/.test(raw.trim())) {
		return 100;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		return 100;
	}
	return Math.min(Math.max(value, 1), 100);
}

/**
 * Sentry cursor format `{id}:{offset}:{isPrev}` (exactly three segments;
 * `id` and `isPrev` are ignored — this surface pages by offset). The offset
 * segment must be a plain digit run within the safe-integer range; anything
 * else reads as offset 0 (malformed cursor).
 */
function parseCursorOffset(cursor: string | undefined): number {
	if (!cursor) {
		return 0;
	}
	const segments = cursor.split(':');
	if (segments.length !== 3 || !/^\d+$/.test(segments[1])) {
		return 0;
	}
	const offset = Number(segments[1]);
	if (!Number.isSafeInteger(offset)) {
		return 0;
	}
	return offset;
}

/** Request URL with the cursor param replaced, other query params preserved. */
function pageLink(requestUrl: string, cursor: string): string {
	const url = new URL(requestUrl);
	url.searchParams.delete('cursor');
	url.searchParams.set('cursor', cursor);
	return url.toString();
}

/**
 * Sentry pagination Link header: `next` and `previous` entries on every
 * page, each carrying `results="true|false"` telling the client whether
 * following it would yield rows (A3).
 */
function buildLinkHeader(requestUrl: string, offset: number, limit: number, total: number): string {
	const nextCursor = `0:${offset + limit}:0`;
	const prevCursor = `0:${Math.max(0, offset - limit)}:1`;
	const next = `<${pageLink(requestUrl, nextCursor)}>; rel="next"; results="${
		offset + limit < total ? 'true' : 'false'
	}"; cursor="${nextCursor}"`;
	const previous = `<${pageLink(requestUrl, prevCursor)}>; rel="previous"; results="${
		offset > 0 ? 'true' : 'false'
	}"; cursor="${prevCursor}"`;
	return `${next}, ${previous}`;
}

/**
 * List an event's attachments. GET
 * /api/0/projects/{org}/{project}/events/{event_id}/attachments[/]
 */
async function handleList(c: AppContext) {
	const projectParam = c.req.param('project');
	const eventId = c.req.param('eventId');

	const project = await resolveCompatProject(c, projectParam);
	if (!project) {
		return c.json({ detail: 'not found' }, 404);
	}

	const limit = parseCompatLimit(c.req.query('limit'));
	const offset = parseCursorOffset(c.req.query('cursor'));

	const projectState = c.env.PROJECT_STATE.get(c.env.PROJECT_STATE.idFromName(project.id));
	const response = await projectState.fetch(
		new Request('http://internal/event/attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventId, orderBy: 'name', limit, offset }),
		}),
	);
	if (!response.ok) {
		return c.json({ detail: 'not found' }, 404);
	}
	const data = (await response.json()) as { attachments: CompatAttachmentRow[]; total: number };

	c.header('Link', buildLinkHeader(c.req.url, offset, limit, data.total));
	return c.json(data.attachments.map(serializeAttachment));
}

/**
 * Attachment detail: metadata JSON, or the raw payload with `?download`
 * (any value, including empty). GET
 * /api/0/projects/{org}/{project}/events/{event_id}/attachments/{attachment_id}[/]
 */
async function handleDetail(c: AppContext) {
	const projectParam = c.req.param('project');
	const eventId = c.req.param('eventId');
	const attachmentId = c.req.param('attachmentId');

	const project = await resolveCompatProject(c, projectParam);
	if (!project) {
		return c.json({ detail: 'not found' }, 404);
	}

	const projectState = c.env.PROJECT_STATE.get(c.env.PROJECT_STATE.idFromName(project.id));
	const response = await projectState.fetch(
		new Request('http://internal/attachment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ attachmentId, eventId }),
		}),
	);
	if (!response.ok) {
		// Unknown event, unknown attachment, or attachment scoped to a
		// different event — indistinguishable by design.
		return c.json({ detail: 'not found' }, 404);
	}
	const data = (await response.json()) as {
		attachment: CompatAttachmentRow & {
			storage: 'inline' | 'r2';
			r2Key?: string;
			data?: string;
		};
	};
	const attachment = data.attachment;

	if (c.req.query('download') === undefined) {
		return c.json(serializeAttachment(attachment));
	}

	// Byte download: stored content type, hardened disposition, exact
	// Content-Length. R2 bodies stream end-to-end (no presigned redirect).
	const commonHeaders = {
		'Content-Type': safeContentType(attachment.contentType),
		'Content-Disposition': contentDisposition(attachment.filename),
	};

	if (attachment.storage === 'inline') {
		const encoded = new TextEncoder().encode(attachment.data ?? '');
		// Plain-ArrayBuffer copy: Hono's body typing rejects SAB-backed views
		const bytes = new Uint8Array(encoded.byteLength);
		bytes.set(encoded);
		return c.body(bytes, 200, { ...commonHeaders, 'Content-Length': String(bytes.byteLength) });
	}

	const key = attachment.r2Key;
	if (!key) {
		console.error(`Attachment blob missing for ${attachmentId}: no R2 key on row`);
		return c.json({ detail: 'attachment data missing' }, 404);
	}
	const object = await c.env.ATTACHMENTS.get(key);
	if (!object || !('body' in object)) {
		// Metadata exists but the blob is gone (GC/lifecycle race window).
		console.error(`Attachment blob missing for ${attachmentId}: R2 key ${key}`);
		return c.json({ detail: 'attachment data missing' }, 404);
	}
	// The runtime ignores a manually-set Content-Length on raw stream bodies,
	// so pipe through FixedLengthStream: the exact length is then known to
	// the runtime (verified over real HTTP — integration round-trip test).
	// pipeTo runs detached; source errors propagate through the stream chain
	// to the client rather than an unhandled rejection.
	const { readable, writable } = new FixedLengthStream(object.size);
	object.body.pipeTo(writable).catch(() => {});
	return c.body(readable, 200, {
		...commonHeaders,
		'Content-Length': String(attachment.size),
	});
}

// Both slashed and unslashed forms are registered explicitly (strict routing
// is on; no global strictness change).
const LIST_PATH = '/projects/:org/:project/events/:eventId/attachments';
const DETAIL_PATH = '/projects/:org/:project/events/:eventId/attachments/:attachmentId';
api0Routes.get(`${LIST_PATH}/`, handleList);
api0Routes.get(LIST_PATH, handleList);
api0Routes.get(`${DETAIL_PATH}/`, handleDetail);
api0Routes.get(DETAIL_PATH, handleDetail);

// ─────────────────────────────────────────────────────────────────────────────
// Issue management, discovery, events, comments (Sentry-shaped triage API)
//
// Wire contract follows docs.sentry.io/api (research round 2026-09, sources
// A1–A22). Deviations from Sentry are deliberate and documented in
// AGENTS.md: synthetic single-tenant organization, UUID issue ids, no token
// scopes, `assignedTo` accepted-but-ignored, empty stats series in lists,
// issue/event lists walk DO keyset pages up to 1000 rows per project,
// deletion is immediate but answers 202 to match Sentry's status contract.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable synthetic organization for the single-tenant deployment. */
const SYNTHETIC_ORG = {
	id: '1',
	slug: 'sentinel',
	name: 'Workers Sentinel',
	status: 'active' as const,
	createdAt: '2026-01-01T00:00:00Z',
	require2FA: false,
	earlyAdopter: false,
};

interface NativeIssue {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	platform: string;
	firstSeen: string;
	lastSeen: string;
	count: number;
	userCount: number;
	status: 'unresolved' | 'resolved' | 'ignored';
	snoozedUntil: string | null;
	metadata: Record<string, unknown>;
}

interface MemberProject extends Project {
	memberRole: string;
}

async function authStateFetch(c: AppContext, path: string, body: unknown): Promise<Response> {
	const authState = c.env.AUTH_STATE.get(c.env.AUTH_STATE.idFromName('global'));
	return authState.fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

async function projectStateFetch(
	c: AppContext,
	projectId: string,
	path: string,
	body: unknown,
): Promise<Response> {
	const projectState = c.env.PROJECT_STATE.get(c.env.PROJECT_STATE.idFromName(projectId));
	return projectState.fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

/** All projects the caller is a member of (auth-gated in AuthState). */
async function memberProjects(c: AppContext): Promise<MemberProject[]> {
	const auth = c.get('auth');
	if (!auth) return [];
	const response = await authStateFetch(c, '/list-projects', { userId: auth.user.id });
	if (!response.ok) return [];
	const data = (await response.json()) as { projects?: MemberProject[] };
	return data.projects ?? [];
}

/** Sentry Group (issue) serializer shape. */
function serializeGroup(
	issue: NativeIssue,
	project: Project,
	requestUrl: string,
	options?: { detail?: boolean; stats?: Array<{ bucket: string; count: number }> },
) {
	const origin = new URL(requestUrl).origin;
	const group: Record<string, unknown> = {
		id: issue.id,
		shortId: null,
		shareId: null,
		title: issue.title,
		culprit: issue.culprit,
		permalink: `${origin}/projects/${project.slug}/issues/${issue.id}`,
		logger: null,
		level: issue.level,
		status: issue.status,
		statusDetails: {},
		substatus: null,
		isPublic: false,
		platform: issue.platform,
		project: {
			id: project.id,
			name: project.name,
			slug: project.slug,
			platform: project.platform,
		},
		type: 'error',
		issueType: 'error',
		issueCategory: 'error',
		metadata: issue.metadata ?? {},
		numComments: 0,
		assignedTo: null,
		isBookmarked: false,
		isSubscribed: false,
		subscriptionDetails: null,
		hasSeen: false,
		annotations: [],
		count: String(issue.count),
		userCount: issue.userCount,
		firstSeen: issue.firstSeen,
		lastSeen: issue.lastSeen,
		stats: { '24h': statsSeries(options?.stats) },
	};
	if (options?.detail) {
		group.activity = [];
		group.seenBy = [];
		group.participants = [];
		group.userReportCount = 0;
		group.firstRelease = null;
		group.lastRelease = null;
		group.tags = [];
	}
	return group;
}

/** `[{bucket ISO, count}]` → Sentry `[[unixSeconds, count], ...]` ascending. */
function statsSeries(stats?: Array<{ bucket: string; count: number }>): Array<[number, number]> {
	if (!stats) return [];
	return stats
		.map(
			(point) =>
				[Math.floor(new Date(point.bucket).getTime() / 1000), point.count] as [number, number],
		)
		.sort((a, b) => a[0] - b[0]);
}

/** Sentry Event serializer subset (fields agents rely on for triage). */
function serializeApi0Event(
	rawEvent: Record<string, unknown>,
	issueId: string,
	project: Project,
): Record<string, unknown> {
	const eventID = String(rawEvent.event_id ?? '');
	const exceptionValue = (rawEvent.exception as { values?: Array<{ value?: string }> } | undefined)
		?.values?.[0]?.value;
	const title = exceptionValue ?? (rawEvent.message as string | undefined) ?? issueId;
	const timestamp = (rawEvent.timestamp as string | undefined) ?? null;
	const tags = rawEvent.tags as Record<string, unknown> | undefined;
	return {
		id: eventID,
		eventID,
		groupID: issueId,
		projectID: project.id,
		message: rawEvent.message ?? title,
		title,
		culprit: rawEvent.culprit ?? rawEvent.transaction ?? null,
		platform: rawEvent.platform ?? project.platform,
		type: 'error',
		metadata: {},
		tags: Object.entries(tags ?? {}).map(([key, value]) => ({ key, value: String(value) })),
		dateCreated: timestamp,
		dateReceived: timestamp,
		user: rawEvent.user ?? null,
		contexts: rawEvent.contexts ?? {},
		sdk: rawEvent.sdk ?? null,
		environment: rawEvent.environment ?? null,
		release: rawEvent.release ?? null,
		fingerprint: rawEvent.fingerprint ?? null,
		entries: [],
		occurrence: null,
		previousEventID: null,
		nextEventID: null,
	};
}

/** Sentry Project serializer subset. */
function serializeApi0Project(project: MemberProject): Record<string, unknown> {
	return {
		id: project.id,
		slug: project.slug,
		name: project.name,
		platform: project.platform,
		platforms: [project.platform],
		dateCreated: project.createdAt,
		isMember: true,
		isBookmarked: false,
		hasAccess: true,
		access: [],
		teams: [],
		environments: [],
		features: [],
		firstEvent: null,
		isInternal: false,
		isPublic: false,
		status: 'active',
	};
}

/** `is:` tokens from a Sentry-style query → status filter. */
function statusFromQuery(query: string | undefined): string | undefined | 'all' {
	if (query === undefined) return 'unresolved'; // Sentry default
	if (query.trim() === '') return 'all'; // explicit empty query = all statuses
	const match = /(?:^|\s)is:(unresolved|resolved|ignored)(?:\s|$)/.exec(query);
	return match ? match[1] : 'all';
}

/** Sentry `sort` names → native DO sort fields (DESC throughout). */
const ISSUE_SORTS: Record<string, string> = {
	date: 'last_seen',
	new: 'first_seen',
	freq: 'count',
	user: 'user_count',
};

interface IssueFetch {
	project: MemberProject;
	issues: NativeIssue[];
	/** True when the DO reported no further pages (exact horizon). */
	exhausted: boolean;
}

/** Walking page cap per project (10 × 100): documented list horizon. */
const ISSUE_PAGES_MAX = 10;

/**
 * Issues from one project, walking the DO's keyset pages until `needed`
 * rows are collected or the project is exhausted (≤1000 rows).
 */
async function fetchProjectIssues(
	c: AppContext,
	project: MemberProject,
	status: string | undefined,
	sort: string,
	needed: number,
): Promise<IssueFetch | null> {
	const collected: NativeIssue[] = [];
	let cursor: string | undefined;
	let exhausted = false;
	for (let page = 0; page < ISSUE_PAGES_MAX && collected.length <= needed; page++) {
		const response = await projectStateFetch(c, project.id, '/issues', {
			status: status === 'all' ? undefined : status,
			sort,
			limit: 100,
			cursor,
		});
		if (!response.ok) return null;
		const data = (await response.json()) as {
			issues?: NativeIssue[];
			nextCursor?: string;
			hasMore?: boolean;
		};
		collected.push(...(data.issues ?? []));
		if (data.hasMore !== true || data.nextCursor === undefined || data.nextCursor === null) {
			exhausted = true;
			break;
		}
		cursor = data.nextCursor;
	}
	return { project, issues: collected, exhausted };
}

/**
 * GET /api/0/organizations/{org}/issues/ and
 * GET /api/0/projects/{org}/{project}/issues/
 */
async function handleIssueList(c: AppContext, scope: 'org' | 'project') {
	const allProjects = await memberProjects(c);
	let projects = allProjects;
	if (scope === 'project') {
		const param = c.req.param('project');
		projects = allProjects.filter((p) => p.slug === param || p.id === param);
		if (projects.length === 0) {
			return c.json({ detail: 'not found' }, 404);
		}
	} else {
		const requested = c.req.queries('project')?.filter((value) => value !== '-1') ?? [];
		if (requested.length > 0) {
			projects = allProjects.filter((p) => requested.includes(p.slug) || requested.includes(p.id));
		}
	}
	if (projects.length === 0) {
		c.header('Link', buildLinkHeader(c.req.url, 0, pageLimitOf(c), 0));
		return c.json([]);
	}

	const status = statusFromQuery(c.req.query('query'));
	const sort = ISSUE_SORTS[c.req.query('sort') ?? 'date'] ?? 'last_seen';
	const limit = pageLimitOf(c);
	const offset = parseCursorOffset(c.req.query('cursor'));
	const needed = offset + limit;

	const fetched = await Promise.all(
		projects.map((p) => fetchProjectIssues(c, p, status, sort, needed)),
	);
	const rows = fetched
		.flatMap(
			(entry): Array<{ issue: NativeIssue; project: MemberProject }> =>
				entry ? entry.issues.map((issue) => ({ issue, project: entry.project })) : [],
		)
		.sort((a, b) => compareBySort(a.issue, b.issue, sort));

	// The accessible horizon IS the collected rows: exhausted projects report
	// their exact end; the 1000-rows/project walk cap simply marks the
	// horizon exhausted there (no endless empty next pages beyond it).
	const total = rows.length;
	const window = rows.slice(offset, offset + limit);
	c.header('Link', buildLinkHeader(c.req.url, offset, limit, total));
	return c.json(window.map(({ issue, project }) => serializeGroup(issue, project, c.req.url)));
}

function compareBySort(a: NativeIssue, b: NativeIssue, sort: string): number {
	const key =
		sort === 'first_seen'
			? 'firstSeen'
			: sort === 'count'
				? 'count'
				: sort === 'user_count'
					? 'userCount'
					: 'lastSeen';
	const av = a[key as 'firstSeen' | 'count' | 'userCount' | 'lastSeen'];
	const bv = b[key as 'firstSeen' | 'count' | 'userCount' | 'lastSeen'];
	const primary =
		typeof av === 'number' && typeof bv === 'number'
			? bv - av
			: String(bv).localeCompare(String(av));
	// Deterministic merge across projects: break ties by id, mirroring the
	// DO's `ORDER BY <field>, id` continuation ordering.
	return primary !== 0 ? primary : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Parse `per_page`/`limit` (issue lists use `limit`, event lists `per_page`). */
function pageLimitOf(c: AppContext, fallback = 25): number {
	const raw = c.req.query('limit') ?? c.req.query('per_page');
	if (raw === undefined) return fallback;
	if (!/^-?\d+$/.test(raw.trim())) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(Math.max(value, 1), 100);
}

/**
 * Resolve an issue id across the caller's member projects (single-tenant
 * fan-out; early exit on first hit). Unknown → null.
 */
async function resolveIssue(
	c: AppContext,
	issueId: string,
): Promise<{
	issue: NativeIssue;
	project: MemberProject;
	stats: Array<{ bucket: string; count: number }>;
} | null> {
	const projects = await memberProjects(c);
	for (const project of projects) {
		const response = await projectStateFetch(c, project.id, '/issue', { issueId });
		if (!response.ok) continue;
		const data = (await response.json()) as {
			issue: NativeIssue;
			stats?: Array<{ bucket: string; count: number }>;
		};
		return { issue: data.issue, project, stats: data.stats ?? [] };
	}
	return null;
}

/** GET issue detail (org-scoped path + the /issues/{id}/ alias). */
async function handleIssueDetail(c: AppContext) {
	const resolved = await resolveIssue(c, c.req.param('issueId'));
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	return c.json(
		serializeGroup(resolved.issue, resolved.project, c.req.url, {
			detail: true,
			stats: resolved.stats,
		}),
	);
}

/** Sentry status mutation values → native status values. */
const STATUS_MAP: Record<string, string> = {
	unresolved: 'unresolved',
	resolved: 'resolved',
	ignored: 'ignored',
	resolvedInNextRelease: 'resolved', // no release-scoped resolution: mapped
	muted: 'ignored', // no mute regime: mapped
};

/** PUT issue update: status triage (resolve / reopen / ignore). */
async function handleIssueUpdate(c: AppContext) {
	const issueId = c.req.param('issueId');
	const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ detail: 'request body must be a JSON object' }, 400);
	}
	// Object.hasOwn: plain-name check, immune to inherited keys like
	// "toString" or "__proto__" that `in` would accept.
	if (
		typeof body.status !== 'string' ||
		!Object.hasOwn(STATUS_MAP, body.status) ||
		typeof STATUS_MAP[body.status] !== 'string'
	) {
		return c.json(
			{ detail: `invalid status: expected one of ${Object.keys(STATUS_MAP).join(', ')}` },
			400,
		);
	}
	const resolved = await resolveIssue(c, issueId);
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	const auth = c.get('auth')!;
	const response = await projectStateFetch(c, resolved.project.id, '/issue/update', {
		issueId,
		status: STATUS_MAP[body.status],
		userId: auth.user.id,
		userName: auth.user.name,
	});
	if (!response.ok) {
		return c.json({ detail: 'failed to update issue' }, response.status as 400);
	}
	const data = (await response.json()) as { issue: NativeIssue };
	return c.json(serializeGroup(data.issue, resolved.project, c.req.url, { detail: true }));
}

/** DELETE issue: deletion is immediate here; 202 matches Sentry's contract. */
async function handleIssueDelete(c: AppContext) {
	const issueId = c.req.param('issueId');
	const resolved = await resolveIssue(c, issueId);
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	const response = await projectStateFetch(c, resolved.project.id, '/issue/delete', { issueId });
	if (!response.ok) {
		return c.json({ detail: 'failed to delete issue' }, response.status as 500);
	}
	return c.body(null, 202);
}

/** Resolve an event id across member projects. */
async function resolveEvent(
	c: AppContext,
	eventId: string,
): Promise<{ event: Record<string, unknown>; issueId: string; project: MemberProject } | null> {
	const projects = await memberProjects(c);
	for (const project of projects) {
		const response = await projectStateFetch(c, project.id, '/event', { eventId });
		if (!response.ok) continue;
		const data = (await response.json()) as {
			event: Record<string, unknown>;
			issueId: string;
		};
		return { event: data.event, issueId: data.issueId, project };
	}
	return null;
}

/** GET /api/0/organizations/{org}/eventids/{event_id}/ */
async function handleEventIdResolve(c: AppContext) {
	const eventId = c.req.param('eventId');
	const resolved = await resolveEvent(c, eventId);
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	return c.json({
		event: serializeApi0Event(resolved.event, resolved.issueId, resolved.project),
		eventId,
		groupId: resolved.issueId,
		organizationSlug: SYNTHETIC_ORG.slug,
		projectSlug: resolved.project.slug,
	});
}

/** Walk one issue's event pages until `needed` or exhausted (≤1000 rows). */
async function fetchIssueEvents(
	c: AppContext,
	projectId: string,
	issueId: string,
	needed: number,
	order: 'asc' | 'desc' = 'desc',
): Promise<{ events: Array<Record<string, unknown>>; exhausted: boolean } | null> {
	const collected: Array<Record<string, unknown>> = [];
	let cursor: string | undefined;
	let exhausted = false;
	for (let page = 0; page < ISSUE_PAGES_MAX && collected.length <= needed; page++) {
		const response = await projectStateFetch(c, projectId, '/issue/events', {
			issueId,
			limit: 100,
			cursor,
			order,
		});
		if (!response.ok) return null;
		const data = (await response.json()) as {
			events?: Array<Record<string, unknown>>;
			nextCursor?: string;
			hasMore?: boolean;
		};
		collected.push(...(data.events ?? []));
		if (data.hasMore !== true || data.nextCursor === undefined || data.nextCursor === null) {
			exhausted = true;
			break;
		}
		cursor = data.nextCursor;
	}
	// An issue always has ≥1 event; an empty page means the issue does not
	// live in this project (the DO treats the id as a filter).
	if (collected.length === 0) return null;
	return { events: collected, exhausted };
}

/** Issue events list (org + project scoped paths share this). */
async function handleIssueEvents(c: AppContext) {
	const issueId = c.req.param('issueId');
	const projectParam = 'project' in c.req.param() ? c.req.param('project') : undefined;
	let target: MemberProject | null = null;
	if (projectParam !== undefined) {
		const match = (await memberProjects(c)).find(
			(p) => p.slug === projectParam || p.id === projectParam,
		);
		target = match ?? null;
		if (!target) {
			return c.json({ detail: 'not found' }, 404);
		}
	}
	const projects = target ? [target] : await memberProjects(c);
	const limit = pageLimitOf(c, 100);
	const offset = parseCursorOffset(c.req.query('cursor'));
	const needed = offset + limit;
	for (const project of projects) {
		const fetched = await fetchIssueEvents(c, project.id, issueId, needed);
		if (!fetched) continue;
		// Collected rows are the accessible horizon (≤1000): exhausted issues
		// report their exact end; the walk cap marks the horizon there.
		const total = fetched.events.length;
		const window = fetched.events.slice(offset, offset + limit);
		c.header('Link', buildLinkHeader(c.req.url, offset, limit, total));
		return c.json(window.map((event) => serializeApi0Event(event, issueId, project)));
	}
	return c.json({ detail: 'not found' }, 404);
}

/** Issue event detail; `{event_id}` may be a concrete id, `latest`, `oldest`. */
async function handleIssueEventDetail(c: AppContext) {
	const issueId = c.req.param('issueId');
	const selector = c.req.param('eventId');
	const projectParam = 'project' in c.req.param() ? c.req.param('project') : undefined;
	let target: MemberProject | null = null;
	if (projectParam !== undefined) {
		target =
			(await memberProjects(c)).find((p) => p.slug === projectParam || p.id === projectParam) ??
			null;
		if (!target) {
			return c.json({ detail: 'not found' }, 404);
		}
	}
	const projects = target ? [target] : await memberProjects(c);

	// Concrete ids resolve exactly through the DO's point lookup — no list
	// horizon involved — and are verified to belong to the requested issue.
	if (selector !== 'latest' && selector !== 'oldest') {
		for (const project of projects) {
			const response = await projectStateFetch(c, project.id, '/event', { eventId: selector });
			if (!response.ok) continue;
			const data = (await response.json()) as {
				event: Record<string, unknown>;
				issueId: string;
			};
			if (data.issueId !== issueId) continue;
			return c.json(serializeApi0Event(data.event, issueId, project));
		}
		return c.json({ detail: 'not found' }, 404);
	}

	// Selectors: latest = newest row, oldest = oldest row (ascending walk)
	const order = selector === 'oldest' ? 'asc' : 'desc';
	for (const project of projects) {
		const fetched = await fetchIssueEvents(c, project.id, issueId, 1, order);
		if (!fetched) continue;
		if (fetched.events[0]) {
			return c.json(serializeApi0Event(fetched.events[0], issueId, project));
		}
	}
	return c.json({ detail: 'not found' }, 404);
}

/** GET /api/0/projects/{org}/{project}/events/{event_id}/ */
async function handleProjectEventDetail(c: AppContext) {
	const projectParam = c.req.param('project');
	const project = (await memberProjects(c)).find(
		(p) => p.slug === projectParam || p.id === projectParam,
	);
	if (!project) {
		return c.json({ detail: 'not found' }, 404);
	}
	const response = await projectStateFetch(c, project.id, '/event', {
		eventId: c.req.param('eventId'),
	});
	if (!response.ok) {
		return c.json({ detail: 'not found' }, 404);
	}
	const data = (await response.json()) as { event: Record<string, unknown>; issueId: string };
	return c.json(serializeApi0Event(data.event, data.issueId, project));
}

/** GET /api/0/organizations/ */
async function handleListOrganizations(c: AppContext) {
	return c.json([SYNTHETIC_ORG]);
}

/** GET /api/0/organizations/{org}/projects/ */
async function handleListProjects(c: AppContext) {
	const query = (c.req.query('query') ?? '').toLowerCase();
	let projects = await memberProjects(c);
	if (query) {
		projects = projects.filter(
			(p) => p.name.toLowerCase().includes(query) || p.slug.toLowerCase().includes(query),
		);
	}
	const limit = pageLimitOf(c, 100);
	const offset = parseCursorOffset(c.req.query('cursor'));
	const window = projects.slice(offset, offset + limit);
	c.header('Link', buildLinkHeader(c.req.url, offset, limit, projects.length));
	return c.json(window.map(serializeApi0Project));
}

/** Comments (Sentry notes shape) over the native comment store. */
async function handleListComments(c: AppContext) {
	const resolved = await resolveIssue(c, c.req.param('issueId'));
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	const response = await projectStateFetch(c, resolved.project.id, '/issue/comments', {
		issueId: resolved.issue.id,
	});
	const data = (await response.json()) as {
		comments: Array<{
			id: string;
			issueId: string;
			userId: string;
			userName: string;
			body: string;
			createdAt: string;
		}>;
	};
	return c.json(
		(data.comments ?? []).map((comment) => ({
			id: comment.id,
			issueId: comment.issueId,
			projectId: resolved.project.id,
			text: comment.body,
			data: {},
			dateCreated: comment.createdAt,
			user: { id: comment.userId, name: comment.userName, username: comment.userName },
		})),
	);
}

async function handleCreateComment(c: AppContext) {
	const issueId = c.req.param('issueId');
	const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
	if (
		body === null ||
		typeof body !== 'object' ||
		Array.isArray(body) ||
		typeof body.text !== 'string' ||
		body.text.trim().length === 0
	) {
		return c.json({ detail: 'text is required' }, 400);
	}
	const resolved = await resolveIssue(c, issueId);
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	const auth = c.get('auth')!;
	const response = await projectStateFetch(c, resolved.project.id, '/issue/comment/add', {
		issueId,
		userId: auth.user.id,
		userName: auth.user.name,
		body: body.text,
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => null)) as { error?: string } | null;
		return c.json({ detail: error?.error ?? 'failed to create comment' }, response.status as 400);
	}
	const comment = (await response.json()) as {
		comment?: { id: string; createdAt?: string; body?: string };
	};
	return c.json(
		{
			id: comment.comment?.id,
			issueId,
			projectId: resolved.project.id,
			text: comment.comment?.body ?? body.text.trim(),
			data: {},
			dateCreated: comment.comment?.createdAt ?? new Date().toISOString(),
			user: { id: auth.user.id, name: auth.user.name, username: auth.user.name },
		},
		201,
	);
}

async function handleDeleteComment(c: AppContext) {
	const issueId = c.req.param('issueId');
	const commentId = c.req.param('commentId');
	const resolved = await resolveIssue(c, issueId);
	if (!resolved) {
		return c.json({ detail: 'not found' }, 404);
	}
	const response = await projectStateFetch(c, resolved.project.id, '/issue/comment/delete', {
		issueId,
		commentId,
		userId: c.get('auth')!.user.id,
	});
	if (!response.ok) {
		const status = response.status === 403 ? 403 : 404;
		const detail =
			status === 403 ? 'you do not have permission to delete this comment' : 'not found';
		return c.json({ detail }, status as 403 | 404);
	}
	return c.body(null, 204);
}

// Registrations: both slashed and unslashed forms (strict routing).
for (const path of ['/organizations', '/organizations/']) {
	api0Routes.get(path, handleListOrganizations);
}
for (const base of ['/organizations/:org/projects', '/organizations/:org/projects/']) {
	api0Routes.get(base, handleListProjects);
}
for (const base of ['/organizations/:org/issues', '/organizations/:org/issues/']) {
	api0Routes.get(base, (c) => handleIssueList(c, 'org'));
}
for (const base of ['/projects/:org/:project/issues', '/projects/:org/:project/issues/']) {
	api0Routes.get(base, (c) => handleIssueList(c, 'project'));
}
for (const base of [
	'/organizations/:org/issues/:issueId',
	'/organizations/:org/issues/:issueId/',
	'/issues/:issueId',
	'/issues/:issueId/',
]) {
	api0Routes.get(base, handleIssueDetail);
	api0Routes.put(base, handleIssueUpdate);
	api0Routes.delete(base, handleIssueDelete);
}
for (const base of [
	'/organizations/:org/eventids/:eventId',
	'/organizations/:org/eventids/:eventId/',
]) {
	api0Routes.get(base, handleEventIdResolve);
}
for (const base of [
	'/organizations/:org/issues/:issueId/events',
	'/organizations/:org/issues/:issueId/events/',
	'/projects/:org/:project/issues/:issueId/events',
	'/projects/:org/:project/issues/:issueId/events/',
]) {
	api0Routes.get(base, handleIssueEvents);
}
for (const base of [
	'/organizations/:org/issues/:issueId/events/:eventId',
	'/organizations/:org/issues/:issueId/events/:eventId/',
	'/projects/:org/:project/issues/:issueId/events/:eventId',
	'/projects/:org/:project/issues/:issueId/events/:eventId/',
]) {
	api0Routes.get(base, handleIssueEventDetail);
}
for (const base of [
	'/projects/:org/:project/events/:eventId',
	'/projects/:org/:project/events/:eventId/',
]) {
	api0Routes.get(base, handleProjectEventDetail);
}
for (const base of [
	'/organizations/:org/issues/:issueId/comments',
	'/organizations/:org/issues/:issueId/comments/',
]) {
	api0Routes.get(base, handleListComments);
	api0Routes.post(base, handleCreateComment);
}
for (const base of [
	'/organizations/:org/issues/:issueId/comments/:commentId',
	'/organizations/:org/issues/:issueId/comments/:commentId/',
]) {
	api0Routes.delete(base, handleDeleteComment);
}

// Namespace-local unmatched-GET fallback: Sentry-style 404 instead of the
// global `{error:'not_found'}` shape. Registered last so the concrete routes
// above match first.
api0Routes.get('*', (c) => c.json({ detail: 'not found' }, 404));
