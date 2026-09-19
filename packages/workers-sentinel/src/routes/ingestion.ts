import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	extractEvents,
	extractKeyFromAuthHeader,
	MAX_COMPRESSED_BODY_BYTES,
	maybeDecompress,
	parseEnvelope,
} from '../lib/envelope-parser';
import { buildWebhookPayload, sendWebhook } from '../lib/webhook';
import type { Env, Project } from '../types';

export const ingestionRoutes = new Hono<{ Bindings: Env }>();

// Sentry browser SDKs POST cross-origin without credentials: these endpoints
// get permissive CORS (wildcard origin, NO credentials). This is the only part
// of the API that may be reached cross-origin by design.
for (const path of [
	'/:projectId/envelope',
	'/:projectId/envelope/',
	'/:projectId/store',
	'/:projectId/store/',
	'/:projectId/security',
]) {
	ingestionRoutes.use(path, cors({ origin: '*', credentials: false }));
}

// Main envelope ingestion endpoint
// POST /api/{project_id}/envelope/
ingestionRoutes.post('/:projectId/envelope', handleIngestion);
ingestionRoutes.post('/:projectId/envelope/', handleIngestion);

// Legacy store endpoint (for older SDKs)
// POST /api/{project_id}/store/
ingestionRoutes.post('/:projectId/store', handleIngestion);
ingestionRoutes.post('/:projectId/store/', handleIngestion);

async function handleIngestion(c: Context<{ Bindings: Env }>): Promise<Response> {
	const projectId = c.req.param('projectId');

	// Extract public key from various sources
	let publicKey: string | null = null;

	// 1. Query parameter: ?sentry_key=xxx
	const sentryKeyParam = c.req.query('sentry_key');
	if (sentryKeyParam) {
		publicKey = sentryKeyParam;
	}

	// 2. X-Sentry-Auth header: Sentry sentry_version=7, sentry_key=xxx, ...
	if (!publicKey) {
		const authHeader = c.req.header('X-Sentry-Auth');
		if (authHeader) {
			publicKey = extractKeyFromAuthHeader(authHeader);
		}
	}

	// 3. Authorization header (basic auth style)
	if (!publicKey) {
		const authHeader = c.req.header('Authorization');
		if (authHeader && /^\s*basic\s+/i.test(authHeader)) {
			try {
				const decoded = atob(authHeader.replace(/^\s*basic\s+/i, ''));
				publicKey = decoded.split(':')[0];
			} catch {
				// Invalid base64
			}
		}
	}

	if (!publicKey) {
		return c.json({ error: 'missing_auth', message: 'No authentication provided' }, 401);
	}

	// Validate the public key against the project
	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const projectResponse = await authState.fetch(
		new Request('http://internal/get-project-by-key', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ publicKey }),
		}),
	);

	if (!projectResponse.ok) {
		return c.json({ error: 'invalid_auth', message: 'Invalid DSN' }, 401);
	}

	const projectData = (await projectResponse.json()) as { project: Project };
	const project = projectData.project;

	// Verify project ID matches (if provided in URL)
	if (projectId && projectId !== project.id) {
		return c.json({ error: 'project_mismatch', message: 'Project ID does not match DSN' }, 400);
	}

	// Parse the request body
	const contentEncoding = c.req.header('Content-Encoding') ?? null;
	const contentType = c.req.header('Content-Type') || '';
	const declaredLength = Number(c.req.header('Content-Length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPRESSED_BODY_BYTES) {
		return c.json({ error: 'payload_too_large', message: 'Envelope exceeds size limit' }, 413);
	}
	const bodyBuffer = await c.req.arrayBuffer();
	if (bodyBuffer.byteLength > MAX_COMPRESSED_BODY_BYTES) {
		return c.json({ error: 'payload_too_large', message: 'Envelope exceeds size limit' }, 413);
	}

	let bodyText: string;
	try {
		bodyText = await maybeDecompress(bodyBuffer, contentEncoding);
	} catch {
		return c.json({ error: 'decompression_failed', message: 'Failed to decompress body' }, 400);
	}

	// Parse envelope or raw event
	let events;
	try {
		if (contentType.includes('application/json') && !bodyText.includes('\n{')) {
			// Raw JSON event (legacy store endpoint)
			const event = JSON.parse(bodyText);
			events = [event];
		} else {
			// Envelope format
			const envelope = parseEnvelope(bodyText);
			events = extractEvents(envelope);
		}
	} catch {
		// Do not log attacker-controlled body content
		return c.json({ error: 'parse_failed', message: 'Failed to parse envelope' }, 400);
	}

	if (events.length === 0) {
		return c.json({ id: null, message: 'No events in envelope' });
	}

	// Get the ProjectState Durable Object for this project
	const projectStateId = c.env.PROJECT_STATE.idFromName(project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	// Ingest each event
	const results = [];
	for (const event of events) {
		try {
			const response = await projectState.fetch(
				new Request('http://internal/ingest', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(event),
				}),
			);

			if (response.status === 429) {
				const retryAfter = response.headers.get('Retry-After') || '3600';
				return c.json(
					{ error: 'rate_limited', message: 'Project event quota exceeded' },
					{ status: 429, headers: { 'Retry-After': retryAfter } },
				);
			}

			if (response.ok) {
				const result = await response.json();
				results.push(result);
			} else {
				// Log status only: response bodies may echo attacker content
				console.error(`Ingest error: status ${response.status}`);
			}
		} catch (error) {
			console.error(
				'Ingest error:',
				error instanceof Error ? error.message.slice(0, 200) : 'unknown',
			);
		}
	}

	// Fire webhooks for new issues (non-blocking)
	if (project.webhookUrl) {
		for (const result of results) {
			const r = result as {
				eventId: string;
				issueId: string;
				isNewIssue?: boolean;
				title?: string;
				level?: string;
				culprit?: string | null;
			};
			if (r.isNewIssue && r.title) {
				const payload = buildWebhookPayload(
					{ id: project.id, name: project.name, slug: project.slug },
					{
						id: r.issueId,
						title: r.title,
						level: r.level || 'error',
						culprit: r.culprit || null,
					},
				);
				c.executionCtx.waitUntil(sendWebhook(project.webhookUrl, payload));
			}
		}
	}

	// Return the first event ID (standard Sentry response)
	const firstResult = results[0] as { eventId: string; duplicate?: boolean } | undefined;
	return c.json({
		id: firstResult?.eventId || events[0]?.event_id || null,
		...(firstResult?.duplicate ? { duplicate: true } : {}),
	});
}

// Security endpoint - returns the project's real ingestion security config
// GET /api/{project_id}/security/
ingestionRoutes.get('/:projectId/security', async (c) => {
	const projectId = c.req.param('projectId');
	const projectStateId = c.env.PROJECT_STATE.idFromName(projectId);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);
	const settingsResponse = await projectState.fetch(
		new Request('http://internal/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}),
	);
	const settings = settingsResponse.ok
		? ((await settingsResponse.json()) as { scrubHeaders?: string[] })
		: {};
	return c.json({
		allowedDomains: ['*'],
		scrubData: true,
		scrubHeaders: settings.scrubHeaders ?? [],
	});
});
