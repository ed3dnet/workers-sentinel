import { Hono } from 'hono';
import { getProjectWithAccess } from '../lib/project-access';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

export const attachmentRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** RFC 7230 token characters (for the content-type shape check). */
const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Remove unpaired UTF-16 surrogates: they are ill-formed strings and would
 * make `encodeURIComponent` throw (URIError: URI malformed).
 */
function stripLoneSurrogates(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: surrogate code units are the exact subject here
	return value.replace(
		/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
		'',
	);
}

/** Strip characters that could break out of a quoted-string header value. */
function asciiSafeFilename(filename: string): string {
	const cleaned = stripLoneSurrogates(filename)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose of this regex
		.replace(/[\x00-\x1f\x7f"\\]/g, '')
		.replace(/^[.\s]+|[.\s]+$/g, '')
		// The quoted fallback must be ASCII-only; non-ASCII names are carried
		// by the RFC 5987 filename* extension instead
		.replace(/[^\x20-\x7e]/g, '')
		.trim();
	return cleaned.length > 0 ? cleaned : 'attachment';
}

/** RFC 5987 encoding: percent-encode everything outside the attr-char set. */
function rfc5987Encode(value: string): string {
	return encodeURIComponent(value).replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: apostrophe/parens are ASCII; this escapes them
		/[*'()]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * Content-Disposition value for an untrusted filename: an ASCII-safe quoted
 * fallback plus an RFC 5987 `filename*` extension carrying the original
 * (possibly non-ASCII) name. Control characters and unpaired surrogates are
 * stripped from both forms so the header never advertises them, even
 * percent-encoded, and encoding can never throw.
 */
export function contentDisposition(filename: string): string {
	const fallback = asciiSafeFilename(filename);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose of this regex
	const starSource = stripLoneSurrogates(filename).replace(/[\x00-\x1f\x7f]/g, '');
	const star = `UTF-8''${rfc5987Encode(starSource)}`;
	const isPlainAscii = /^[\x20-\x7e]+$/.test(starSource);
	return isPlainAscii
		? `attachment; filename="${fallback}"`
		: `attachment; filename="${fallback}"; filename*=${star}`;
}

/** Only structurally valid `type/subtype` values pass through unchanged. */
export function safeContentType(contentType: string): string {
	const [type, subtype, ...rest] = contentType.trim().split('/');
	if (rest.length === 0 && type && subtype && TOKEN_CHAR.test(type) && TOKEN_CHAR.test(subtype)) {
		return `${type}/${subtype}`;
	}
	return 'application/octet-stream';
}

/**
 * List attachment metadata for one event (no payload data).
 * GET /api/projects/:slug/events/:eventId/attachments
 */
attachmentRoutes.get('/:slug/events/:eventId/attachments', async (c) => {
	const slug = c.req.param('slug');
	const eventId = c.req.param('eventId');

	const projectResult = await getProjectWithAccess(c, slug);
	if (projectResult instanceof Response) {
		return projectResult;
	}

	const { project } = projectResult;

	const projectStateId = c.env.PROJECT_STATE.idFromName(project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	const response = await projectState.fetch(
		new Request('http://internal/event/attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventId }),
		}),
	);

	if (!response.ok) {
		const error = await response.json();
		return c.json(error, response.status as 404);
	}

	const data = await response.json();
	return c.json(data);
});

/** Parsed single-range request (RFC 9110 `bytes=` unit only). */
interface ByteRange {
	offset: number;
	length: number;
}

/**
 * Copy into a buffer backed by a plain ArrayBuffer (Hono's body typing
 * rejects SharedArrayBuffer-backed views).
 */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

/**
 * Parse a `Range` header against a known total size. Returns a satisfiable
 * range, `'unsatisfiable'` (→ 416), or null when the header is absent or
 * malformed (→ full 200 response, per RFC guidance to ignore bad ranges).
 * Only a single range is supported; multi-range requests fall back to 200.
 */
function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (match[1] === '' && match[2] === '')) return null;
	const total = size;
	if (match[1] === '') {
		// suffix range: last N bytes (unsatisfiable on an empty representation)
		const suffix = Number.parseInt(match[2], 10);
		if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
		if (total === 0) return 'unsatisfiable';
		if (suffix >= total) return { offset: 0, length: total };
		return { offset: total - suffix, length: suffix };
	}
	const start = Number.parseInt(match[1], 10);
	if (!Number.isInteger(start) || start < 0) return null;
	if (start >= total) return 'unsatisfiable';
	if (match[2] === '') {
		return { offset: start, length: total - start };
	}
	const end = Number.parseInt(match[2], 10);
	if (!Number.isInteger(end) || end < start) return null;
	return { offset: start, length: Math.min(end, total - 1) - start + 1 };
}

/**
 * Download one attachment (payload bytes, stored content type, safe
 * Content-Disposition). Scoping is inherent: the attachment row lives in the
 * project's own Durable Object, which also tells the worker where the
 * payload lives — inline (`data`, legacy rows awaiting migration) or R2
 * (`r2Key`, streamed from the bucket with `Range` support). Metadata
 * existing while the blob is gone is reported distinctly (GC/lifecycle race
 * window) so consumers can tell a deleted attachment from a missing blob.
 * GET /api/projects/:slug/attachments/:attachmentId
 */
attachmentRoutes.get('/:slug/attachments/:attachmentId', async (c) => {
	const slug = c.req.param('slug');
	const attachmentId = c.req.param('attachmentId');

	const projectResult = await getProjectWithAccess(c, slug);
	if (projectResult instanceof Response) {
		return projectResult;
	}

	const { project } = projectResult;

	const projectStateId = c.env.PROJECT_STATE.idFromName(project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	const response = await projectState.fetch(
		new Request('http://internal/attachment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ attachmentId }),
		}),
	);

	if (!response.ok) {
		const error = await response.json();
		return c.json(error, response.status as 404);
	}

	const data = (await response.json()) as {
		attachment: {
			filename: string;
			contentType: string;
			size: number;
			storage: 'inline' | 'r2';
			r2Key?: string;
			data?: string;
		};
	};
	const attachment = data.attachment;
	const commonHeaders = {
		'Content-Type': safeContentType(attachment.contentType),
		'Content-Disposition': contentDisposition(attachment.filename),
	};

	if (attachment.storage === 'inline') {
		const bytes = copyBytes(new TextEncoder().encode(attachment.data ?? ''));
		const range = parseRange(c.req.header('Range'), bytes.byteLength);
		if (range === 'unsatisfiable') {
			return c.body(null, 416, {
				...commonHeaders,
				'Content-Range': `bytes */${bytes.byteLength}`,
			});
		}
		if (range) {
			const slice = bytes.subarray(range.offset, range.offset + range.length);
			return c.body(slice, 206, {
				...commonHeaders,
				'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${
					bytes.byteLength
				}`,
			});
		}
		return c.body(bytes, 200, commonHeaders);
	}

	// R2-backed payload
	const key = attachment.r2Key;
	if (!key) {
		return c.json({ error: 'attachment_data_missing' }, 404);
	}
	const size = attachment.size;
	const range = parseRange(c.req.header('Range'), size);
	if (range === 'unsatisfiable') {
		return c.body(null, 416, {
			...commonHeaders,
			'Content-Range': `bytes */${size}`,
		});
	}

	const object = await c.env.ATTACHMENTS.get(key, range ? { range } : undefined);
	if (!object || !('body' in object)) {
		// Metadata exists but the blob is gone (deleted underneath a listed
		// attachment). Distinct from `attachment_not_found`.
		console.error(`Attachment blob missing for ${attachmentId}: R2 key ${key}`);
		return c.json({ error: 'attachment_data_missing' }, 404);
	}

	if (range) {
		return c.body(object.body, 206, {
			...commonHeaders,
			'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
		});
	}
	return c.body(object.body, 200, commonHeaders);
});
