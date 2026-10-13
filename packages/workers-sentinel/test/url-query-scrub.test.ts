// Regression: redaction scrubbed secret-ish query parameters in
// request.query_string only — an event whose request.url carried the query
// (python-style SDKs embed it there) stored tokens verbatim, readable on every
// event GET and in the /api/0 serializers. The same secret-parameter scrub is
// now applied to request.url's query portion, preserving scheme, path, and
// non-secret parameters. Deterministic regression, no fast-check.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

async function storedUrlFor(extra: Record<string, unknown>): Promise<string | undefined> {
	const project = await createTestProject(owner.token!, {
		name: `url-scrub-${crypto.randomUUID().slice(0, 8)}`,
	});
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const envelope = [
		JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			platform: 'python',
			level: 'error',
			message: 'url scrub probe',
			...extra,
		}),
	].join('\n');
	const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}` },
		body: enc.encode(envelope) as unknown as BodyInit,
	});
	expect(response.status, await response.text()).toBe(200);
	const detail = await SELF.fetch(
		`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		{
			headers: { Authorization: `Bearer ${owner.token!}` },
		},
	);
	expect(detail.status).toBe(200);
	return ((await detail.json()) as { event: { request?: { url?: string } } }).event.request?.url;
}

describe('request.url query scrubbing', () => {
	test('secret params in request.url are filtered; path and benign params survive', async () => {
		const url = await storedUrlFor({
			request: {
				url: 'https://app.example/path?ok=1&api_token=URLSECRETTOKEN&password=hunter2&next=/home',
			},
		});
		expect(url).toBeDefined();
		expect(url).toContain('https://app.example/path?');
		expect(url).toContain('ok=1');
		expect(url).toContain('next=/home');
		expect(url).not.toContain('URLSECRETTOKEN');
		expect(url).not.toContain('hunter2');
		expect(url).toContain('api_token=[Filtered]');
		expect(url).toContain('password=[Filtered]');
	});

	test('urls without a query are untouched', async () => {
		const url = await storedUrlFor({ request: { url: 'https://app.example/plain/path' } });
		expect(url).toBe('https://app.example/plain/path');
	});
});
