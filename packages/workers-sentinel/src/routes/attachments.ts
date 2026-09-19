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

/**
 * Download one attachment (payload bytes, stored content type, safe
 * Content-Disposition). Scoping is inherent: the attachment row lives in the
 * project's own Durable Object.
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
			data: string;
		};
	};

	return c.body(data.attachment.data, 200, {
		'Content-Type': safeContentType(data.attachment.contentType),
		'Content-Disposition': contentDisposition(data.attachment.filename),
	});
});
