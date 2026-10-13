// Regression: a project's custom scrubHeaders list REPLACED the default
// sensitive-header list — PATCHing scrubHeaders: ['x-custom-secret'] silently
// stopped scrubbing authorization, cookie, x-api-key, and the rest of the
// defaults, leaving raw credentials in stored events and on every event GET.
// The settings list now unions with the defaults: custom entries can only add
// protection, never remove the floor. Deterministic regression, no fast-check.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

describe('scrubHeaders unions with the defaults', () => {
	test('a custom list adds entries; default sensitive headers stay scrubbed', async () => {
		const project = await createTestProject(owner.token!, {
			name: `scrub-union-${crypto.randomUUID().slice(0, 8)}`,
		});

		const patch = await SELF.fetch(`http://localhost/api/projects/${project.slug}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${owner.token!}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ scrubHeaders: ['x-custom-secret'] }),
		});
		expect(patch.status, await patch.text()).toBe(200);

		const eventId = crypto.randomUUID().replace(/-/g, '');
		const envelope = [
			JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` }),
			JSON.stringify({ type: 'event' }),
			JSON.stringify({
				event_id: eventId,
				timestamp: new Date().toISOString(),
				platform: 'javascript',
				level: 'error',
				message: 'scrub union probe',
				request: {
					headers: {
						'x-custom-secret': 'custom-secret-value',
						authorization: 'Bearer must-be-filtered',
						cookie: 'session=must-be-filtered',
						accept: 'text/plain',
					},
				},
			}),
		].join('\n');
		const ingestResponse = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}` },
			body: enc.encode(envelope) as unknown as BodyInit,
		});
		expect(ingestResponse.status, await ingestResponse.text()).toBe(200);

		const detail = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
			{
				headers: { Authorization: `Bearer ${owner.token!}` },
			},
		);
		expect(detail.status).toBe(200);
		const stored = (
			(await detail.json()) as { event: { request?: { headers?: Record<string, string> } } }
		).event;
		expect(stored.request?.headers?.['x-custom-secret']).toBe('[Filtered]');
		expect(stored.request?.headers?.authorization).toBe('[Filtered]');
		expect(stored.request?.headers?.cookie).toBe('[Filtered]');
		expect(stored.request?.headers?.accept).toBe('text/plain');
	});

	test('the settings GET reflects the union', async () => {
		const project = await createTestProject(owner.token!, {
			name: `scrub-union-get-${crypto.randomUUID().slice(0, 8)}`,
		});
		const patch = await SELF.fetch(`http://localhost/api/projects/${project.slug}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${owner.token!}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ scrubHeaders: ['x-another'] }),
		});
		expect(patch.status).toBe(200);
		const settings = await SELF.fetch(`http://localhost/api/projects/${project.slug}/settings`, {
			headers: { Authorization: `Bearer ${owner.token!}` },
		});
		expect(settings.status).toBe(200);
		const data = (await settings.json()) as { scrubHeaders: string[] };
		expect(data.scrubHeaders).toContain('x-another');
		expect(data.scrubHeaders).toContain('authorization');
		expect(data.scrubHeaders).toContain('cookie');
	});
});
