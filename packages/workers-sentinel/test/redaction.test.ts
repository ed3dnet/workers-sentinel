import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser } from './utils';

describe('event payload redaction', () => {
	it('strips sensitive request data before storage', { timeout: 30000 }, async () => {
		const user = await createTestUser({
			email: `scrub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Scrub User',
		});
		const project = await createTestProject(user.token!, { name: `Scrub ${Date.now()}` });

		const eventId = crypto.randomUUID().replace(/-/g, '');
		const envelope = [
			JSON.stringify({
				event_id: eventId,
				dsn: `https://${project.publicKey}@localhost/${project.id}`,
			}),
			JSON.stringify({ type: 'event' }),
			JSON.stringify({
				event_id: eventId,
				timestamp: new Date().toISOString(),
				level: 'error',
				exception: { values: [{ type: 'Error', value: 'scrub probe 2' }] },
				request: {
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer super-secret-token',
						'X-Api-Key': 'abc123',
						'X-Custom': 'keep-me',
					},
					cookies: { session: 'session-secret' },
					env: { DATABASE_PASSWORD: 'hunter2' },
					query_string: '?api_token=tok123&verbose=1',
				},
				user: { id: 'u1', ip_address: '203.0.113.9' },
			}),
		].join('\n');

		const ingest = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: envelope,
		});
		expect(ingest.ok).toBe(true);

		// Fetch the stored event and verify redaction
		const stored = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(stored.ok).toBe(true);
		const storedData = (await stored.json()) as {
			event?: {
				request?: {
					headers?: Record<string, string>;
					cookies?: unknown;
					env?: Record<string, string>;
					query_string?: string;
				};
				user?: { ip_address?: string | null };
			};
		};
		const event = storedData.event ?? (storedData as { event?: typeof storedData.event }).event;
		const request = event?.request;
		expect(request?.headers?.Authorization).toBe('[Filtered]');
		expect(request?.headers?.['X-Api-Key']).toBe('[Filtered]');
		expect(request?.headers?.['X-Custom']).toBe('keep-me');
		expect(request?.cookies).toBe('[Filtered]');
		expect(request?.env?.DATABASE_PASSWORD).toBe('[Filtered]');
		expect(request?.query_string).toContain('api_token=[Filtered]');
		expect(request?.query_string).toContain('verbose=1');
		// ip_address removed (undefined or null — the key must not carry a value)
		expect(event?.user?.ip_address == null).toBe(true);
	});

	it('exposes the real scrub configuration on /security', async () => {
		const user = await createTestUser({
			email: `sec-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Sec Endpoint User',
		});
		const project = await createTestProject(user.token!, { name: `Sec ${Date.now()}` });

		const response = await SELF.fetch(`http://localhost/api/${project.id}/security`);
		expect(response.ok).toBe(true);
		const data = (await response.json()) as { scrubData: boolean; scrubHeaders: string[] };
		expect(data.scrubData).toBe(true);
		expect(data.scrubHeaders).toContain('authorization');
	});
});
