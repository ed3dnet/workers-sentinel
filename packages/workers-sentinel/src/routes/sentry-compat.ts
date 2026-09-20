import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../lib/project-access';
import type { AuthContext, Env, Project } from '../types';
import { contentDisposition, safeContentType } from './attachments';

type Variables = {
	auth?: AuthContext;
};

/**
 * Sentry `/api/0` event-attachment compatibility surface (read-only). The
 * org path segment is accepted but ignored (single tenant); the project
 * segment resolves by slug first, then by id. Attachment ids are the native
 * opaque `{eventId}:{n}` composites, passed back verbatim by clients.
 */
export const sentryCompatRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Error-shape translator for the /api/0 namespace: non-2xx JSON bodies shaped
 * `{error[, message]}` (the native API's error convention, including
 * authMiddleware's early 401 returns) are rewritten to Sentry's
 * `{"detail": …}` on this surface only. Must be registered BEFORE
 * authMiddleware on `/api/0/*` — registration order is wrap order in Hono, so
 * the translator's `await next()` surrounds auth's early returns; a
 * translator registered after auth would never see them.
 */
export const sentryCompatErrorTranslator = createMiddleware<{
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
sentryCompatRoutes.get(`${LIST_PATH}/`, handleList);
sentryCompatRoutes.get(LIST_PATH, handleList);
sentryCompatRoutes.get(`${DETAIL_PATH}/`, handleDetail);
sentryCompatRoutes.get(DETAIL_PATH, handleDetail);

// Namespace-local unmatched-GET fallback: Sentry-style 404 instead of the
// global `{error:'not_found'}` shape. Registered last so the concrete routes
// above match first.
sentryCompatRoutes.get('*', (c) => c.json({ detail: 'not found' }, 404));
