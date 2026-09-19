// Black-box integration tests. Run by scripts/integration.mjs against a
// freshly booted wrangler dev instance; the base URL and the fresh install's
// SETUP_TOKEN arrive via environment. Never point these at a shared stack —
// they mutate global settings and rely on a pristine user table.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const BASE = process.env.SENTINEL_INTEGRATION_URL;
const SETUP_TOKEN = process.env.SENTINEL_SETUP_TOKEN;

if (!BASE || !SETUP_TOKEN) {
	throw new Error('SENTINEL_INTEGRATION_URL and SENTINEL_SETUP_TOKEN must be set');
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: {
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	return { status: response.status, headers: response.headers, data };
}

function envelope(publicKey, projectId, payload, eventId) {
	return [
		JSON.stringify({ event_id: eventId, dsn: `https://${publicKey}@localhost/${projectId}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			level: 'error',
			platform: 'node',
			...payload,
		}),
	].join('\n');
}

async function ingest(project, payload, eventId) {
	// Raw fetch: the envelope is newline-delimited text, not JSON — a JSON
	// serializer would quote and escape it into garbage.
	const response = await fetch(`${BASE}/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
		},
		body: envelope(project.publicKey, project.id, payload, eventId),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	return { status: response.status, headers: response.headers, data };
}

test('fresh install requires the setup token for the first (admin) registration', async () => {
	const email = `first-${runId}@example.com`;
	const denied = await api('/api/auth/register', {
		method: 'POST',
		body: { email, password: 'testpassword123', name: 'First User' },
	});
	assert.equal(denied.status, 403);
	assert.equal(denied.data.error, 'setup_token_required');

	const granted = await api('/api/auth/register', {
		method: 'POST',
		body: { email, password: 'testpassword123', name: 'First User', setupToken: SETUP_TOKEN },
	});
	assert.equal(granted.status, 200);
	assert.equal(granted.data.user.role, 'admin');
});

test('admin can close and reopen registration', async () => {
	const login = await api('/api/auth/login', {
		method: 'POST',
		body: { email: `first-${runId}@example.com`, password: 'testpassword123' },
	});
	assert.equal(login.status, 200);
	const adminToken = login.data.token;

	const closed = await api('/api/admin/settings', {
		method: 'PUT',
		token: adminToken,
		body: { registrationOpen: false },
	});
	assert.equal(closed.status, 200);
	assert.equal(closed.data.settings.registrationOpen, false);

	const rejected = await api('/api/auth/register', {
		method: 'POST',
		body: {
			email: `closed-${runId}@example.com`,
			password: 'testpassword123',
			name: 'Closed',
			setupToken: SETUP_TOKEN,
		},
	});
	assert.equal(rejected.status, 403);
	assert.equal(rejected.data.error, 'registration_disabled');

	const reopened = await api('/api/admin/settings', {
		method: 'PUT',
		token: adminToken,
		body: { registrationOpen: true },
	});
	assert.equal(reopened.status, 200);
});

test('login lockout engages after five failures', async () => {
	const email = `locked-${runId}@example.com`;
	const register = await api('/api/auth/register', {
		method: 'POST',
		body: { email, password: 'testpassword123', name: 'Locked User' },
	});
	assert.equal(register.status, 200);

	for (let i = 0; i < 5; i++) {
		const wrong = await api('/api/auth/login', {
			method: 'POST',
			body: { email, password: 'wrong-password-xyz' },
		});
		assert.equal(wrong.status, 401);
	}
	const locked = await api('/api/auth/login', {
		method: 'POST',
		body: { email, password: 'testpassword123' },
	});
	assert.equal(locked.status, 429);
	assert.equal(locked.data.error, 'too_many_attempts');
	assert.ok(locked.data.retryAfter > 0);
});

test('ingestion groups duplicates, redacts secrets and clamps pagination', async () => {
	const login = await api('/api/auth/login', {
		method: 'POST',
		body: { email: `first-${runId}@example.com`, password: 'testpassword123' },
	});
	assert.equal(login.status, 200);
	const token = login.data.token;

	const created = await api('/api/projects', {
		method: 'POST',
		token,
		body: { name: `Integration ${runId}`, platform: 'node' },
	});
	assert.equal(created.status, 200);
	const project = created.data.project;

	// Same exception twice: one issue, count 2
	const exception = {
		exception: {
			values: [
				{
					type: 'Error',
					value: 'integration probe',
					stacktrace: { frames: [{ filename: 'a.ts', function: 'f', lineno: 1, in_app: true }] },
				},
			],
		},
	};
	const hex = () => crypto.randomUUID().replace(/-/g, '');
	const dupId = hex();
	const first = await ingest(project, exception, dupId);
	assert.equal(first.status, 200);
	// Replaying the same event_id is idempotent: acknowledged, not counted twice
	const second = await ingest(project, exception, dupId);
	assert.equal(second.status, 200);
	assert.equal(second.data.duplicate, true);
	// A distinct event with the same exception groups into the same issue
	const third = await ingest(project, exception, hex());
	assert.equal(third.status, 200);

	const issues = await api(`/api/projects/${project.slug}/issues`, { token });
	assert.equal(issues.status, 200);
	const issueList = issues.data.issues ?? issues.data;
	assert.equal(issueList.length, 1);
	assert.equal(issueList[0].count, 2);

	// Redaction through the real HTTP stack
	const redactionEvent = {
		exception: { values: [{ type: 'Error', value: 'redaction probe' }] },
		request: { headers: { Authorization: 'Bearer integration-secret' }, cookies: 'session=abc' },
	};
	const redactionId = hex();
	const ingested = await ingest(project, redactionEvent, redactionId);
	assert.equal(ingested.status, 200);

	const stored = await api(`/api/projects/${project.slug}/events/${redactionId}`, { token });
	assert.equal(stored.status, 200);
	const storedEvent = stored.data.event ?? stored.data;
	assert.equal(storedEvent.request.headers.Authorization, '[Filtered]');
	assert.equal(storedEvent.request.cookies, '[Filtered]');

	// Pagination clamp
	const clamped = await api(`/api/projects/${project.slug}/events/latest?limit=-1`, { token });
	assert.equal(clamped.status, 200);
	const clampedEvents = clamped.data.events ?? clamped.data;
	assert.ok(clampedEvents.length <= 25, `expected <=25 events, got ${clampedEvents.length}`);
});

test('CORS and security headers behave through the real stack', async () => {
	const evil = await fetch(`${BASE}/api/projects`, {
		method: 'OPTIONS',
		headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
	});
	assert.equal(evil.status, 204);
	assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);

	const login = await api('/api/auth/login', {
		method: 'POST',
		body: { email: `first-${runId}@example.com`, password: 'testpassword123' },
	});
	const project = (
		await api('/api/projects', {
			method: 'POST',
			token: login.data.token,
			body: { name: `CORS ${runId}`, platform: 'node' },
		})
	).data.project;

	const sdk = await fetch(`${BASE}/api/${project.id}/envelope/`, {
		method: 'OPTIONS',
		headers: {
			Origin: 'https://customer.example',
			'Access-Control-Request-Method': 'POST',
		},
	});
	assert.equal(sdk.headers.get('Access-Control-Allow-Origin'), '*');
	assert.equal(sdk.headers.get('Access-Control-Allow-Credentials'), null);

	const page = await fetch(`${BASE}/`);
	const csp = page.headers.get('Content-Security-Policy') ?? '';
	if ((page.headers.get('Content-Type') ?? '').includes('text/html')) {
		assert.ok(csp.includes("script-src 'self'"), `missing CSP: ${csp}`);
	}
	assert.equal(page.headers.get('X-Frame-Options'), 'DENY');

	const health = await fetch(`${BASE}/api/health`);
	assert.equal(health.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('webhook URL validation rejects non-https targets', async () => {
	const login = await api('/api/auth/login', {
		method: 'POST',
		body: { email: `first-${runId}@example.com`, password: 'testpassword123' },
	});
	const projects = await api('/api/projects', { token: login.data.token });
	const list = projects.data.projects ?? projects.data;
	const project = list[0];

	const rejected = await api(`/api/projects/${project.slug}`, {
		method: 'PATCH',
		token: login.data.token,
		body: { webhookUrl: 'http://hooks.example/endpoint' },
	});
	assert.equal(rejected.status, 400);
	assert.equal(rejected.data.error, 'invalid_url');
});
