import { Hono } from 'hono';
import { activeFaultMode, createAttachmentStore, projectPrefix } from '../lib/attachment-store';
import {
	FEEDBACK_MAX_METADATA_BYTES,
	FEEDBACK_MAX_REQUEST_BYTES,
	FEEDBACK_MAX_SCREENSHOT_BYTES,
	hasAllowedRasterSignature,
	isAllowedRasterType,
} from '../lib/feedback-validation';
import { getProjectWithAccess } from '../lib/project-access';
import type { AuthContext, Env, Project } from '../types';

type Variables = { auth?: AuthContext };
export const feedbackRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function jsonError(error: string, status: 400 | 401 | 404 | 413 | 429 | 500 | 503): Response {
	return Response.json({ error }, { status });
}

async function readBoundedBody(request: Request, cap: number): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (Number.isFinite(declared) && declared > cap) {
		await cancelRequestBody(request);
		return null;
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > cap) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function clampFeedbackLimit(value: number): number {
	if (!Number.isFinite(value) || value < 1) return 25;
	return Math.min(Math.floor(value), 100);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length <= max;
}

async function cancelRequestBody(request: Request): Promise<void> {
	if (!request.body || request.bodyUsed) return;
	try {
		await request.body.cancel();
	} catch {
		// The client may already have closed the upload stream.
	}
}

function validJsonValue(value: unknown, depth = 0): boolean {
	if (depth > 5) return false;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value))
		return value.length <= 100 && value.every((v) => validJsonValue(v, depth + 1));
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		return (
			entries.length <= 100 &&
			entries.every(([k, v]) => k.length <= 100 && validJsonValue(v, depth + 1))
		);
	}
	return false;
}

function parseGeometry(value: unknown): Record<string, number> | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'object' || Array.isArray(value)) return null;
	const geometry = value as Record<string, unknown>;
	const keys = ['x', 'y', 'width', 'height'];
	if (
		!keys.every(
			(key) =>
				typeof geometry[key] === 'number' &&
				Number.isFinite(geometry[key]) &&
				Math.abs(geometry[key] as number) <= 10_000_000 &&
				(!['width', 'height'].includes(key) || (geometry[key] as number) >= 0),
		)
	)
		return null;
	return Object.fromEntries(keys.map((key) => [key, geometry[key] as number]));
}

function stateFor(env: Env, projectId: string): DurableObjectStub {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
}

async function authProject(env: Env, publicKey: string): Promise<Project | null> {
	const auth = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
	const response = await auth.fetch(
		new Request('http://internal/get-project-by-key', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ publicKey }),
		}),
	);
	if (!response.ok) return null;
	return ((await response.json()) as { project: Project }).project;
}

async function callState(
	env: Env,
	projectId: string,
	path: string,
	body: unknown,
): Promise<Response> {
	return stateFor(env, projectId).fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

feedbackRoutes.options('/:projectId/feedback', (c) => c.body(null, 204));
feedbackRoutes.options('/:projectId/feedback/', (c) => c.body(null, 204));

feedbackRoutes.post('/:projectId/feedback', async (c) => {
	const projectId = c.req.param('projectId');
	const publicKey = c.req.query('sentry_key');
	if (!publicKey || publicKey.length > 200) {
		await cancelRequestBody(c.req.raw);
		return jsonError('missing_auth', 401);
	}
	const project = await authProject(c.env, publicKey);
	if (!project) {
		await cancelRequestBody(c.req.raw);
		return jsonError('invalid_auth', 401);
	}
	if (project.id !== projectId) {
		await cancelRequestBody(c.req.raw);
		return jsonError('project_mismatch', 401);
	}

	const bytes = await readBoundedBody(c.req.raw, FEEDBACK_MAX_REQUEST_BYTES);
	if (!bytes) return jsonError('payload_too_large', 413);
	let form: FormData;
	try {
		form = await new Response(bytes, {
			headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
		}).formData();
	} catch {
		return jsonError('invalid_multipart', 400);
	}
	const metadataPart = form.get('metadata');
	const formKeys = Array.from(form.keys());
	if (
		!/^multipart\/form-data\s*;\s*boundary=(?:"[^"]+"|[^;\s]+)\s*$/i.test(
			c.req.header('Content-Type') ?? '',
		) ||
		formKeys.some((key) => key !== 'metadata' && key !== 'screenshot') ||
		form.getAll('metadata').length !== 1 ||
		form.getAll('screenshot').length > 1 ||
		(form.has('screenshot') && !(form.get('screenshot') instanceof File)) ||
		typeof metadataPart !== 'string' ||
		new TextEncoder().encode(metadataPart).byteLength > FEEDBACK_MAX_METADATA_BYTES
	)
		return jsonError('invalid_metadata', 400);
	let metadata: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(metadataPart);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			return jsonError('invalid_metadata', 400);
		metadata = parsed as Record<string, unknown>;
	} catch {
		return jsonError('invalid_metadata', 400);
	}
	if (
		!boundedString(metadata.description, 4000) ||
		metadata.description.trim().length === 0 ||
		!boundedString(metadata.pageUrl, 2048) ||
		!boundedString(metadata.pageTitle, 300) ||
		!boundedString(metadata.locator, 1000) ||
		metadata.locator.trim().length === 0 ||
		!validJsonValue(metadata.metadata ?? null) ||
		new TextEncoder().encode(JSON.stringify(metadata.metadata ?? null)).byteLength > 8192
	) {
		return jsonError('invalid_metadata', 400);
	}
	let pageUrl: string;
	try {
		const parsed = new URL(metadata.pageUrl);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
			return jsonError('invalid_metadata', 400);
		parsed.username = '';
		parsed.password = '';
		for (const key of [...parsed.searchParams.keys()]) {
			if (/(token|secret|password|passwd|auth|api[_-]?key|session|code)/i.test(key)) {
				parsed.searchParams.delete(key);
			}
		}
		parsed.hash = '';
		pageUrl = parsed.toString().slice(0, 2048);
	} catch {
		return jsonError('invalid_metadata', 400);
	}
	const geometry = parseGeometry(metadata.geometry);
	if (metadata.geometry !== undefined && metadata.geometry !== null && !geometry)
		return jsonError('invalid_metadata', 400);

	const image = form.get('screenshot');
	let screenshot: Uint8Array | null = null;
	let screenshotType: string | null = null;
	if (image !== null) {
		if (
			!(image instanceof File) ||
			image.size < 1 ||
			image.size > FEEDBACK_MAX_SCREENSHOT_BYTES ||
			!isAllowedRasterType(image.type)
		)
			return jsonError('invalid_screenshot', 400);
		screenshot = new Uint8Array(await image.arrayBuffer());
		screenshotType = image.type;
		if (!hasAllowedRasterSignature(image.type, screenshot))
			return jsonError('invalid_screenshot', 400);
	}

	const feedbackId = crypto.randomUUID();
	const objectKey = screenshot
		? `${projectPrefix(project.id)}feedback/${crypto.randomUUID()}`
		: null;
	const touched = await callState(c.env, project.id, '/feedback/touch', { projectId: project.id });
	if (!touched.ok) return jsonError('feedback_unavailable', 503);
	const prepare = await callState(c.env, project.id, '/feedback/prepare', {
		id: feedbackId,
		objectKey,
		screenshotSize: screenshot?.byteLength ?? 0,
	});
	if (!prepare.ok) {
		const result = (await prepare.json().catch(() => ({}))) as { error?: string };
		return jsonError(
			result.error ?? 'feedback_unavailable',
			prepare.status === 429 ? 429 : prepare.status === 413 ? 413 : 503,
		);
	}

	let uploaded = false;
	try {
		if (screenshot && objectKey) {
			await createAttachmentStore(
				c.env,
				activeFaultMode(c.env, c.req.header('X-Sentinel-Test-Fault')),
			).uploadAttachment(objectKey, screenshot, screenshot.byteLength);
			uploaded = true;
		}
		const fault = activeFaultMode(c.env, c.req.header('X-Sentinel-Test-Fault'));
		const stored = await callState(c.env, project.id, '/feedback/commit', {
			id: feedbackId,
			fault: fault === 'feedback-commit' ? fault : undefined,
			description: metadata.description.trim().slice(0, 4000),
			pageUrl,
			pageTitle: metadata.pageTitle,
			locator: metadata.locator,
			geometry,
			metadata: metadata.metadata ?? null,
			screenshotKey: objectKey,
			screenshotType,
			screenshotSize: screenshot?.byteLength ?? 0,
		});
		if (!stored.ok) throw new Error('metadata_write_failed');
		return c.json({ success: true, id: feedbackId }, 201);
	} catch {
		if (uploaded && objectKey) {
			try {
				await createAttachmentStore(
					c.env,
					activeFaultMode(c.env, c.req.header('X-Sentinel-Test-Fault')),
				).deleteKeys([objectKey]);
			} catch {
				/* GC is the backstop */
			}
		}
		await callState(c.env, project.id, '/feedback/abort', { id: feedbackId }).catch(() => {});
		return jsonError('feedback_storage_failed', 503);
	}
});

function publicFeedback(row: Record<string, unknown>) {
	return {
		id: row.id,
		description: row.description,
		pageUrl: row.pageUrl,
		pageTitle: row.pageTitle,
		locator: row.locator,
		geometry: row.geometry,
		metadata: row.metadata,
		receivedAt: row.receivedAt,
		screenshotType: row.screenshotType,
		screenshotSize: row.screenshotSize,
	};
}

feedbackRoutes.get('/projects/:slug/feedback', async (c) => {
	const access = await getProjectWithAccess(c, c.req.param('slug'));
	if (access instanceof Response) return access;
	const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
	const limit = clampFeedbackLimit(rawLimit);
	const response = await callState(c.env, access.project.id, '/feedback/list', {
		cursor: c.req.query('cursor'),
		limit,
	});
	if (!response.ok) return c.json(await response.json(), response.status as 404);
	const result = (await response.json()) as {
		feedback: Array<Record<string, unknown>>;
		nextCursor?: string;
		hasMore: boolean;
	};
	return c.json({ ...result, feedback: result.feedback.map(publicFeedback) });
});

feedbackRoutes.get('/projects/:slug/feedback/:feedbackId', async (c) => {
	const access = await getProjectWithAccess(c, c.req.param('slug'));
	if (access instanceof Response) return access;
	const response = await callState(c.env, access.project.id, '/feedback/detail', {
		id: c.req.param('feedbackId'),
	});
	if (!response.ok) return c.json(await response.json(), response.status as 404);
	const result = (await response.json()) as { feedback: Record<string, unknown> };
	return c.json({ feedback: publicFeedback(result.feedback) });
});

feedbackRoutes.get('/projects/:slug/feedback/:feedbackId/screenshot', async (c) => {
	const access = await getProjectWithAccess(c, c.req.param('slug'));
	if (access instanceof Response) return access;
	const response = await callState(c.env, access.project.id, '/feedback/detail', {
		id: c.req.param('feedbackId'),
	});
	if (!response.ok) return c.json(await response.json(), response.status as 404);
	const result = (await response.json()) as {
		feedback: { screenshotKey?: string; screenshotType?: string | null; screenshotSize?: number };
	};
	const { screenshotKey, screenshotType, screenshotSize } = result.feedback;
	if (
		!screenshotKey ||
		!screenshotKey.startsWith(projectPrefix(access.project.id)) ||
		!screenshotType ||
		!isAllowedRasterType(screenshotType)
	)
		return jsonError('screenshot_not_found', 404);
	const object = await c.env.ATTACHMENTS.get(screenshotKey);
	if (!object) return jsonError('screenshot_data_missing', 404);
	return new Response(object.body, {
		headers: {
			'Content-Type': screenshotType,
			'Content-Length': String(screenshotSize ?? object.size),
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store',
		},
	});
});
