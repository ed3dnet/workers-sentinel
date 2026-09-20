// Sentry /api/0 attachment compatibility surface (plan AC.1–AC.5). The
// compat routes run through the full worker middleware chain via SELF —
// CORS/OPTIONS, security headers, the /api/0 error translator, auth, routes.
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { sentryCompatErrorTranslator } from '../src/routes/sentry-compat';
import type { AuthContext, Env } from '../src/types';
import { authFetch, createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

type TestProject = Awaited<ReturnType<typeof createTestProject>>;

function frame(parts: Array<string | Uint8Array>): Uint8Array {
	const encoded = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
	const total = encoded.reduce((n, e) => n + e.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of encoded) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function envelopeHeader(project: TestProject, eventId: string): string {
	return JSON.stringify({
		event_id: eventId,
		dsn: `https://${project.publicKey}@localhost/${project.id}`,
	});
}

function eventItem(eventId: string, message: string): Array<string | Uint8Array> {
	return [
		JSON.stringify({ type: 'event' }),
		'\n',
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			platform: 'javascript',
			level: 'error',
			message,
		}),
		'\n',
	];
}

function attachmentItem(
	filename: string,
	data: string | Uint8Array,
	contentType = 'text/plain',
): Array<string | Uint8Array> {
	const bytes = typeof data === 'string' ? enc.encode(data) : data;
	return [
		JSON.stringify({
			type: 'attachment',
			filename,
			content_type: contentType,
			length: bytes.byteLength,
		}),
		'\n',
		bytes,
		'\n',
	];
}

async function postEnvelope(project: TestProject, bytes: Uint8Array): Promise<void> {
	const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
		},
		body: bytes as unknown as BodyInit,
	});
	expect(response.status, `envelope ingest failed: ${await response.text()}`).toBe(200);
}

const hexId = () => crypto.randomUUID().replace(/-/g, '');

/** Deterministic non-UTF-8 pattern of `size` bytes. */
function pattern(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		out[i] = i % 251;
	}
	return out;
}

function compatBase(org: string, project: string, eventId: string): string {
	return `http://localhost/api/0/projects/${org}/${project}/events/${eventId}/attachments`;
}

async function compatFetch(
	token: string | undefined,
	url: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(url, {
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
		},
	});
}

/** Nine fields Sentry's event-attachment serializer emits, exactly. */
const COMPAT_FIELDS = [
	'id',
	'event_id',
	'type',
	'name',
	'mimetype',
	'dateCreated',
	'size',
	'headers',
	'sha1',
].sort();

interface CompatAttachment {
	id: string;
	event_id: string;
	type: string;
	name: string;
	mimetype: string;
	dateCreated: string;
	size: number;
	headers: { 'Content-Type'?: string };
	sha1: null;
}

async function compatList(
	token: string | undefined,
	org: string,
	project: string,
	eventId: string,
	query = '',
): Promise<{ status: number; body: unknown; headers: Headers }> {
	const response = await compatFetch(token, `${compatBase(org, project, eventId)}/${query}`);
	const text = await response.text();
	return {
		status: response.status,
		body: text ? JSON.parse(text) : null,
		headers: response.headers,
	};
}

interface ParsedLink {
	url: string;
	results: string;
	cursor: string;
}

function parseLinkHeader(header: string | null): { next?: ParsedLink; previous?: ParsedLink } {
	const out: { next?: ParsedLink; previous?: ParsedLink } = {};
	if (!header) return out;
	for (const part of header.split(', ')) {
		const url = /<([^>]+)>/.exec(part)?.[1];
		const rel = /rel="([^"]+)"/.exec(part)?.[1];
		const results = /results="([^"]*)"/.exec(part)?.[1];
		const cursor = /cursor="([^"]*)"/.exec(part)?.[1];
		if (url && rel && results !== undefined && cursor !== undefined) {
			out[rel as 'next' | 'previous'] = { url, results, cursor };
		}
	}
	return out;
}

async function listR2Keys(prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await env.ATTACHMENTS.list({ prefix, cursor });
		keys.push(...page.objects.map((o) => o.key));
		if (!page.truncated) return keys;
		cursor = page.cursor;
	}
}

/** Seed a legacy inline attachment row directly in the ProjectState DO. */
async function seedInlineAttachment(
	project: TestProject,
	eventId: string,
	filename: string,
	data: string,
): Promise<void> {
	const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
	const response = await stub.fetch('http://internal/ingest-with-attachments', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			projectId: project.id,
			event: {
				event_id: eventId,
				timestamp: new Date().toISOString(),
				platform: 'javascript',
				level: 'error',
				message: 'compat inline legacy row',
			},
			attachments: [{ filename, contentType: 'text/plain', size: data.length, data }],
		}),
	});
	expect(response.status, 'inline seed failed').toBe(200);
}

describe('Sentry /api/0 attachment compatibility', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let outsider: Awaited<ReturnType<typeof createTestUser>>;

	beforeAll(async () => {
		owner = await createTestUser({
			email: `compat-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Compat Owner',
		});
		outsider = await createTestUser({
			email: `compat-out-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Compat Outsider',
		});
	});

	it('compat list returns a bare nine-field array ordered by name', async () => {
		const project = await createTestProject(owner.token!, { name: `Compat list ${Date.now()}` });
		const eventId = hexId();
		// Insertion order deliberately differs from alphabetical order
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'compat list shape'),
				...attachmentItem('zeta.txt', 'zzz'),
				...attachmentItem('alpha.txt', 'aaa'),
				...attachmentItem('mid.log', 'mmm'),
			]),
		);

		// Slashed form, any org segment, slug resolution
		const slashed = await compatList(owner.token, 'any-org', project.slug, eventId);
		expect(slashed.status).toBe(200);
		expect(Array.isArray(slashed.body)).toBe(true);
		const items = slashed.body as CompatAttachment[];
		expect(items.map((a) => a.name)).toEqual(['alpha.txt', 'mid.log', 'zeta.txt']);
		for (const item of items) {
			expect(Object.keys(item).sort()).toEqual(COMPAT_FIELDS);
			expect(item.event_id).toBe(eventId);
			expect(item.type).toBe('event.attachment');
			expect(item.sha1).toBeNull();
			expect(item.mimetype).toBe('text/plain');
			expect(item.headers['Content-Type']).toBe(item.mimetype);
			expect(item.size).toBe(3);
			expect(item.id.startsWith(`${eventId}:`)).toBe(true);
			expect(Number.isNaN(Date.parse(item.dateCreated))).toBe(false);
		}

		// Unslashed form returns the same payload
		const unslashed = await compatFetch(owner.token, compatBase('any-org', project.slug, eventId));
		expect(unslashed.status).toBe(200);
		expect(await unslashed.json()).toEqual(items);

		// Project id resolution through the same route
		const byId = await compatList(owner.token, 'other-org', project.id, eventId);
		expect(byId.status).toBe(200);
		expect(byId.body).toEqual(items);
	}, 60_000);

	it('compat download streams byte-identical payloads with sentry headers', async () => {
		const project = await createTestProject(owner.token!, {
			name: `Compat dl ${Date.now()}`,
		});
		const eventId = hexId();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
		const big = pattern(100 * 1024);
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'compat download shape'),
				...attachmentItem('screenshot.png', png, 'image/png'),
				...attachmentItem('dump.bin', big, 'application/octet-stream'),
				...attachmentItem('empty.txt', new Uint8Array(0), 'text/plain'),
			]),
		);

		const list = await compatList(owner.token, 'o', project.slug, eventId);
		expect(list.status).toBe(200);
		const items = list.body as CompatAttachment[];
		expect(items.map((a) => a.name)).toEqual(['dump.bin', 'empty.txt', 'screenshot.png']);

		const expected: Record<string, Uint8Array> = {
			'screenshot.png': png,
			'dump.bin': big,
			'empty.txt': new Uint8Array(0),
		};
		for (const item of items) {
			// Metadata on the same id: nine-field JSON object, not bytes
			const metaResponse = await compatFetch(
				owner.token,
				`${compatBase('o', project.slug, eventId)}/${item.id}/`,
			);
			expect(metaResponse.status).toBe(200);
			expect(await metaResponse.json()).toEqual(item);

			// Download: byte-identical payload, stored content type, disposition
			const download = await compatFetch(
				owner.token,
				`${compatBase('o', project.slug, eventId)}/${item.id}/?download=1`,
			);
			expect(download.status).toBe(200);
			expect(download.headers.get('Content-Type')).toBe(item.mimetype);
			const disposition = download.headers.get('Content-Disposition') ?? '';
			expect(disposition.startsWith('attachment;')).toBe(true);
			expect(disposition.includes(item.name)).toBe(true);
			expect(new Uint8Array(await download.arrayBuffer())).toEqual(expected[item.name]);
		}

		// Unslashed detail form: metadata and download
		const pngItem = items.find((a) => a.name === 'screenshot.png')!;
		const metaUnslashed = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventId)}/${pngItem.id}`,
		);
		expect(metaUnslashed.status).toBe(200);
		expect(await metaUnslashed.json()).toEqual(pngItem);
		const dlUnslashed = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventId)}/${pngItem.id}?download`,
		);
		expect(dlUnslashed.status).toBe(200);
		expect(new Uint8Array(await dlUnslashed.arrayBuffer())).toEqual(png);

		// `?download=` with an explicitly empty value downloads too
		const dlEmptyValue = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventId)}/${pngItem.id}/?download=`,
		);
		expect(dlEmptyValue.status).toBe(200);
		expect(new Uint8Array(await dlEmptyValue.arrayBuffer())).toEqual(png);

		// Legacy inline row (payload in DO `data`, pre-migration): the compat
		// download path serves it from the inline transport
		const inlineEvent = hexId();
		await seedInlineAttachment(project, inlineEvent, 'legacy.log', 'legacy payload');
		const inlineList = await compatList(owner.token, 'o', project.slug, inlineEvent);
		expect(inlineList.status).toBe(200);
		const inlineItem = (inlineList.body as CompatAttachment[])[0];
		const inlineDownload = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, inlineEvent)}/${inlineItem.id}/?download=1`,
		);
		expect(inlineDownload.status).toBe(200);
		expect(inlineDownload.headers.get('Content-Type')).toBe('text/plain');
		expect(new TextDecoder().decode(new Uint8Array(await inlineDownload.arrayBuffer()))).toBe(
			'legacy payload',
		);
	}, 120_000);

	it('compat auth and error shapes', async () => {
		const project = await createTestProject(owner.token!, { name: `Compat err ${Date.now()}` });
		const eventId = hexId();
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'compat error shapes'),
				...attachmentItem('probe.txt', 'probe payload'),
			]),
		);
		const list = await compatList(owner.token, 'o', project.slug, eventId);
		expect(list.status).toBe(200);
		const attachmentId = (list.body as CompatAttachment[])[0].id;
		const otherEvent = hexId();
		const noSuchEvent = hexId();
		const noSuchAttachment = `${hexId()}:0`;

		// A second, fully authenticated user that is NOT a member of the
		// project — exercises the alsoTryId fallback's membership JOIN on a
		// project that actually exists (missing-project cases cannot).
		const matrix: Array<{
			name: string;
			url: string;
			token?: string;
			status: number;
			body: Record<string, unknown>;
		}> = [
			{
				name: 'anonymous list',
				url: `${compatBase('o', project.slug, eventId)}/`,
				status: 401,
				// Literal pinned from src/middleware/auth.ts
				body: { detail: 'Missing or invalid authorization header' },
			},
			{
				name: 'DSN public key as bearer',
				url: `${compatBase('o', project.slug, eventId)}/`,
				token: project.publicKey,
				status: 401,
				body: { detail: 'Invalid or expired session' },
			},
			{
				name: 'invalid wst_ token',
				url: `${compatBase('o', project.slug, eventId)}/`,
				token: 'wst_totally-invalid-token',
				status: 401,
				body: { detail: 'Invalid or expired API token' },
			},
			{
				name: 'missing project via slug',
				url: `${compatBase('o', 'no-such-slug', eventId)}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'missing project via id',
				url: `${compatBase('o', hexId(), eventId)}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: list via slug',
				url: `${compatBase('o', project.slug, eventId)}/`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: list via id',
				url: `${compatBase('o', project.id, eventId)}/`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: metadata via slug',
				url: `${compatBase('o', project.slug, eventId)}/${attachmentId}/`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: metadata via id',
				url: `${compatBase('o', project.id, eventId)}/${attachmentId}/`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: download via slug',
				url: `${compatBase('o', project.slug, eventId)}/${attachmentId}/?download=1`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'membership isolation: download via id',
				url: `${compatBase('o', project.id, eventId)}/${attachmentId}/?download=1`,
				token: outsider.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'nonexistent list event',
				url: `${compatBase('o', project.slug, noSuchEvent)}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'nonexistent detail event',
				url: `${compatBase('o', project.slug, noSuchEvent)}/${attachmentId}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'wrong-event metadata',
				url: `${compatBase('o', project.slug, otherEvent)}/${attachmentId}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'wrong-event download',
				url: `${compatBase('o', project.slug, otherEvent)}/${attachmentId}/?download=1`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'nonexistent attachment metadata',
				url: `${compatBase('o', project.slug, eventId)}/${noSuchAttachment}/`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'nonexistent attachment download',
				url: `${compatBase('o', project.slug, eventId)}/${noSuchAttachment}/?download=1`,
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'authenticated unknown compat path',
				url: 'http://localhost/api/0/organizations/',
				token: owner.token,
				status: 404,
				body: { detail: 'not found' },
			},
			{
				name: 'anonymous unknown compat path',
				url: 'http://localhost/api/0/organizations/',
				status: 401,
				body: { detail: 'Missing or invalid authorization header' },
			},
		];

		for (const row of matrix) {
			const response = await compatFetch(row.token, row.url);
			expect(response.status, row.name).toBe(row.status);
			expect(await response.json(), row.name).toEqual(row.body);
		}

		// Deleted R2 blob with retained metadata: metadata stays 200 while the
		// download reports the missing blob distinctly.
		const blobProject = await createTestProject(owner.token!, {
			name: `Compat blob ${Date.now()}`,
		});
		const blobEvent = hexId();
		await postEnvelope(
			blobProject,
			frame([
				envelopeHeader(blobProject, blobEvent),
				'\n',
				...eventItem(blobEvent, 'compat missing blob'),
				...attachmentItem('gone.txt', 'now you see me'),
			]),
		);
		const blobList = await compatList(owner.token, 'o', blobProject.slug, blobEvent);
		expect(blobList.status).toBe(200);
		const blobAttachment = (blobList.body as CompatAttachment[])[0];
		const keys = await listR2Keys(`p/${blobProject.id}/`);
		expect(keys).toHaveLength(1);
		await env.ATTACHMENTS.delete(keys[0]);
		const metaAfter = await compatFetch(
			owner.token,
			`${compatBase('o', blobProject.slug, blobEvent)}/${blobAttachment.id}/`,
		);
		expect(metaAfter.status).toBe(200);
		expect(await metaAfter.json()).toEqual(blobAttachment);
		const downloadAfter = await compatFetch(
			owner.token,
			`${compatBase('o', blobProject.slug, blobEvent)}/${blobAttachment.id}/?download=1`,
		);
		expect(downloadAfter.status).toBe(404);
		expect(await downloadAfter.json()).toEqual({ detail: 'attachment data missing' });

		// Security headers survive translation on this namespace
		const anon = await compatFetch(undefined, `${compatBase('o', project.slug, eventId)}/`);
		expect(anon.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(anon.headers.get('X-Frame-Options')).toBe('DENY');

		// OPTIONS preflight on /api/0/* still answers with the bare 204 from
		// the global CORS handler (before auth or translation)
		const options = await SELF.fetch(`${compatBase('o', project.slug, eventId)}/`, {
			method: 'OPTIONS',
		});
		expect(options.status).toBe(204);
		expect(await options.text()).toBe('');
		expect(options.headers.get('Access-Control-Allow-Origin')).toBeNull();

		// Success with a wst_ API token — list, metadata, and download
		const created = await authFetch(owner.token!, 'http://localhost/api/auth/tokens', {
			method: 'POST',
			body: JSON.stringify({ name: 'compat-suite' }),
		});
		expect(created.status).toBe(200);
		const { rawToken } = (await created.json()) as { rawToken: string };
		const viaApiToken = await compatList(rawToken, 'o', project.slug, eventId);
		expect(viaApiToken.status).toBe(200);
		expect((viaApiToken.body as CompatAttachment[]).map((a) => a.name)).toEqual(['probe.txt']);
		const apiTokenMeta = await compatFetch(
			rawToken,
			`${compatBase('o', project.slug, eventId)}/${attachmentId}/`,
		);
		expect(apiTokenMeta.status).toBe(200);
		expect(await apiTokenMeta.json()).toEqual((viaApiToken.body as CompatAttachment[])[0]);
		const apiTokenDownload = await compatFetch(
			rawToken,
			`${compatBase('o', project.slug, eventId)}/${attachmentId}/?download=1`,
		);
		expect(apiTokenDownload.status).toBe(200);
		expect(new TextDecoder().decode(new Uint8Array(await apiTokenDownload.arrayBuffer()))).toBe(
			'probe payload',
		);
	}, 120_000);

	it('compat error translator hardening', async () => {
		// Unit-level probe of the namespace translator against unusual error
		// bodies (thrown-exception text 500s, JSON null, invalid JSON) that
		// the happy-path matrix cannot produce through real routes.
		const probe = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>();
		probe.get('/text-error', sentryCompatErrorTranslator, (c) =>
			c.text('Internal Server Error', 500),
		);
		probe.get('/json-null', sentryCompatErrorTranslator, (c) => c.json(null, 500));
		probe.get(
			'/bad-json',
			sentryCompatErrorTranslator,
			() =>
				new Response('{not json', {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		probe.get('/already-detail', sentryCompatErrorTranslator, (c) =>
			c.json({ detail: 'not found' }, 404),
		);
		probe.get('/ok', sentryCompatErrorTranslator, (c) => c.text('fine'));

		// Non-JSON 5xx (Hono's default thrown-exception shape) becomes a
		// generic detail body without echoing exception details
		const textError = await probe.request('/text-error');
		expect(textError.status).toBe(500);
		expect(await textError.json()).toEqual({ detail: 'internal server error' });

		// JSON null / invalid JSON bodies rebuild verbatim (no throw on
		// non-object shapes)
		const jsonNull = await probe.request('/json-null');
		expect(jsonNull.status).toBe(500);
		expect(await jsonNull.text()).toBe('null');
		const badJson = await probe.request('/bad-json');
		expect(badJson.status).toBe(500);
		expect(await badJson.text()).toBe('{not json');

		// Already Sentry-shaped bodies pass through unchanged
		const alreadyDetail = await probe.request('/already-detail');
		expect(alreadyDetail.status).toBe(404);
		expect(await alreadyDetail.json()).toEqual({ detail: 'not found' });

		// 2xx responses are untouched
		const ok = await probe.request('/ok');
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('fine');
	});

	it('compat event scoping', async () => {
		const project = await createTestProject(owner.token!, {
			name: `Compat scope ${Date.now()}`,
		});
		const eventA = hexId();
		const eventB = hexId();
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventA),
				'\n',
				...eventItem(eventA, 'compat scoping owner'),
				...attachmentItem('scoped.txt', 'scoped payload'),
			]),
		);
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventB),
				'\n',
				...eventItem(eventB, 'compat scoping other event'),
			]),
		);

		const list = await compatList(owner.token, 'o', project.slug, eventA);
		expect(list.status).toBe(200);
		const attachmentId = (list.body as CompatAttachment[])[0].id;

		// Same project, wrong event: attachment is not found under eventB
		const wrongMeta = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventB)}/${attachmentId}/`,
		);
		expect(wrongMeta.status).toBe(404);
		expect(await wrongMeta.json()).toEqual({ detail: 'not found' });
		const wrongDownload = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventB)}/${attachmentId}/?download=1`,
		);
		expect(wrongDownload.status).toBe(404);
		expect(await wrongDownload.json()).toEqual({ detail: 'not found' });

		// Nonexistent event on both routes
		const ghost = hexId();
		const ghostList = await compatList(owner.token, 'o', project.slug, ghost);
		expect(ghostList.status).toBe(404);
		expect(ghostList.body).toEqual({ detail: 'not found' });
		const ghostMeta = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, ghost)}/${attachmentId}/`,
		);
		expect(ghostMeta.status).toBe(404);
		expect(await ghostMeta.json()).toEqual({ detail: 'not found' });

		// The correct event still serves both forms
		const rightMeta = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventA)}/${attachmentId}`,
		);
		expect(rightMeta.status).toBe(200);
		const rightDownload = await compatFetch(
			owner.token,
			`${compatBase('o', project.slug, eventA)}/${attachmentId}/?download=1`,
		);
		expect(rightDownload.status).toBe(200);
		expect(new TextDecoder().decode(new Uint8Array(await rightDownload.arrayBuffer()))).toBe(
			'scoped payload',
		);
	}, 60_000);

	it('compat link pagination', async () => {
		const project = await createTestProject(owner.token!, { name: `Compat page ${Date.now()}` });
		const eventId = hexId();
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'compat pagination'),
				...attachmentItem('alpha.txt', 'a'),
				...attachmentItem('beta.txt', 'b'),
				...attachmentItem('gamma.txt', 'c'),
			]),
		);

		// Page 1: alpha+beta, next flagged usable, previous flagged empty
		const page1 = await compatList(owner.token, 'o', project.slug, eventId, '?limit=2');
		expect(page1.status).toBe(200);
		expect((page1.body as CompatAttachment[]).map((a) => a.name)).toEqual([
			'alpha.txt',
			'beta.txt',
		]);
		const links1 = parseLinkHeader(page1.headers.get('Link'));
		expect(links1.next?.results).toBe('true');
		expect(links1.next?.cursor).toBe('0:2:0');
		expect(links1.previous?.results).toBe('false');
		expect(links1.previous?.cursor).toBe('0:0:1');
		expect(links1.next?.url.startsWith('http://')).toBe(true);

		// Follow next: gamma alone, next now flagged exhausted
		const page2 = await compatFetch(owner.token, links1.next!.url);
		expect(page2.status).toBe(200);
		expect(((await page2.json()) as CompatAttachment[]).map((a) => a.name)).toEqual(['gamma.txt']);
		const links2 = parseLinkHeader(page2.headers.get('Link'));
		expect(links2.next?.results).toBe('false');
		expect(links2.next?.cursor).toBe('0:4:0');
		expect(links2.previous?.results).toBe('true');
		expect(links2.previous?.cursor).toBe('0:0:1');

		// Follow previous: back to the first page with original flags
		const page1again = await compatFetch(owner.token, links2.previous!.url);
		expect(page1again.status).toBe(200);
		expect(((await page1again.json()) as CompatAttachment[]).map((a) => a.name)).toEqual([
			'alpha.txt',
			'beta.txt',
		]);
		const links1again = parseLinkHeader(page1again.headers.get('Link'));
		expect(links1again.next?.results).toBe('true');
		expect(links1again.previous?.results).toBe('false');

		// Malformed cursors are treated as offset 0 (first page)
		const malformed = await compatList(
			owner.token,
			'o',
			project.slug,
			eventId,
			'?limit=2&cursor=garbage',
		);
		expect(malformed.status).toBe(200);
		expect((malformed.body as CompatAttachment[]).map((a) => a.name)).toEqual([
			'alpha.txt',
			'beta.txt',
		]);

		// Cursor strictness: partial-garbage, non-integer, wrong segment count,
		// and unsafe-integer offsets all read as offset 0
		for (const cursor of [
			'0:2garbage:0',
			'0:2.5:0',
			'0:2',
			'0:2:0:9',
			'0:99999999999999999999:0',
			'0:-2:0',
		]) {
			const row = await compatList(
				owner.token,
				'o',
				project.slug,
				eventId,
				`?limit=2&cursor=${encodeURIComponent(cursor)}`,
			);
			expect(row.status, `cursor ${cursor}`).toBe(200);
			expect((row.body as CompatAttachment[]).map((a) => a.name)).toEqual([
				'alpha.txt',
				'beta.txt',
			]);
		}

		// Limit clamping: 0 and negatives clamp up to 1; oversized clamps to
		// 100; non-integers fall back to the default
		const zero = await compatList(owner.token, 'o', project.slug, eventId, '?limit=0');
		expect((zero.body as CompatAttachment[]).map((a) => a.name)).toEqual(['alpha.txt']);
		expect(parseLinkHeader(zero.headers.get('Link')).next?.results).toBe('true');
		const negative = await compatList(owner.token, 'o', project.slug, eventId, '?limit=-5');
		expect((negative.body as CompatAttachment[]).map((a) => a.name)).toEqual(['alpha.txt']);
		const oversized = await compatList(owner.token, 'o', project.slug, eventId, '?limit=250');
		expect((oversized.body as CompatAttachment[]).map((a) => a.name)).toEqual([
			'alpha.txt',
			'beta.txt',
			'gamma.txt',
		]);
		expect(parseLinkHeader(oversized.headers.get('Link')).next?.results).toBe('false');
		for (const raw of ['abc', '2.5']) {
			const fallback = await compatList(owner.token, 'o', project.slug, eventId, `?limit=${raw}`);
			expect((fallback.body as CompatAttachment[]).map((a) => a.name)).toEqual([
				'alpha.txt',
				'beta.txt',
				'gamma.txt',
			]);
		}

		// Exactly-full page: the last row fills the window, next is exhausted
		const full = await compatList(owner.token, 'o', project.slug, eventId, '?limit=3');
		expect((full.body as CompatAttachment[]).map((a) => a.name)).toEqual([
			'alpha.txt',
			'beta.txt',
			'gamma.txt',
		]);
		expect(parseLinkHeader(full.headers.get('Link')).next?.results).toBe('false');

		// Offset beyond total: empty page, next exhausted, previous usable
		const beyond = await compatList(
			owner.token,
			'o',
			project.slug,
			eventId,
			'?limit=2&cursor=0:10:0',
		);
		expect(beyond.body).toEqual([]);
		const beyondLinks = parseLinkHeader(beyond.headers.get('Link'));
		expect(beyondLinks.next?.results).toBe('false');
		expect(beyondLinks.previous?.results).toBe('true');

		// Unrelated query params are preserved in emitted Link URLs
		const preserved = await compatList(owner.token, 'o', project.slug, eventId, '?limit=2&foo=bar');
		const preservedLinks = parseLinkHeader(preserved.headers.get('Link'));
		expect(preservedLinks.next?.url.includes('foo=bar')).toBe(true);

		// An event with no attachments: bare empty array, both flags false
		const bareEvent = hexId();
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, bareEvent),
				'\n',
				...eventItem(bareEvent, 'compat empty list'),
			]),
		);
		const empty = await compatList(owner.token, 'o', project.slug, bareEvent);
		expect(empty.status).toBe(200);
		expect(empty.body).toEqual([]);
		const emptyLinks = parseLinkHeader(empty.headers.get('Link'));
		expect(emptyLinks.next?.results).toBe('false');
		expect(emptyLinks.previous?.results).toBe('false');
	}, 120_000);

	it('native list shape and rowid order unchanged', async () => {
		const project = await createTestProject(owner.token!, { name: `Compat native ${Date.now()}` });
		const eventId = hexId();
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'native shape unchanged'),
				...attachmentItem('zulu.txt', 'z'),
				...attachmentItem('alpha.txt', 'a'),
				...attachmentItem('mike.log', 'm'),
			]),
		);

		const response = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}/attachments`,
		);
		expect(response.status).toBe(200);
		const data = (await response.json()) as Record<string, unknown>;

		// Exact top-level keys — no compat-mode `total` leaked in
		expect(Object.keys(data).sort()).toEqual(['attachments', 'issueId']);
		expect(typeof data.issueId).toBe('string');

		const attachments = data.attachments as Array<Record<string, unknown>>;
		// Insertion (rowid) order preserved — NOT alphabetical
		expect(attachments.map((a) => a.filename)).toEqual(['zulu.txt', 'alpha.txt', 'mike.log']);
		for (const attachment of attachments) {
			expect(Object.keys(attachment).sort()).toEqual([
				'contentType',
				'createdAt',
				'eventId',
				'filename',
				'id',
				'size',
			]);
			expect(attachment.eventId).toBe(eventId);
		}
	}, 60_000);
});
