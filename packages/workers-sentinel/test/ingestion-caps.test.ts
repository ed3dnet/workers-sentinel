import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser } from './utils';

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(data.buffer as ArrayBuffer).body!.pipeThrough(
		new CompressionStream('gzip'),
	);
	const buf = await new Response(stream).arrayBuffer();
	return new Uint8Array(buf);
}

function envelopeWith(
	publicKey: string,
	projectId: string,
	payload: Record<string, unknown>,
	eventId: string,
) {
	return [
		JSON.stringify({ event_id: eventId, dsn: `https://${publicKey}@localhost/${projectId}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({ event_id: eventId, timestamp: new Date().toISOString(), ...payload }),
	].join('\n');
}

async function postEnvelope(
	project: { id: string; publicKey: string },
	body: string | Uint8Array,
	extraHeaders: Record<string, string> = {},
) {
	return SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			...extraHeaders,
		},
		body: body as BodyInit,
	});
}

describe('ingestion input caps and validation', () => {
	it('rejects bodies over the compressed size limit with 413', async () => {
		const user = await createTestUser({
			email: `caps-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Caps User',
		});
		const project = await createTestProject(user.token!, { name: `Caps ${Date.now()}` });

		const bigPayload = 'x'.repeat(1100 * 1024);
		const body = envelopeWith(
			project.publicKey,
			project.id,
			{ message: bigPayload },
			crypto.randomUUID().replace(/-/g, ''),
		);
		const response = await postEnvelope(project, body);
		expect(response.status).toBe(413);
	});

	it('rejects gzip bombs that decompress beyond the cap', async () => {
		const user = await createTestUser({
			email: `bomb-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Bomb User',
		});
		const project = await createTestProject(user.token!, { name: `Bomb ${Date.now()}` });

		const bigPayload = 'y'.repeat(6 * 1024 * 1024);
		const body = envelopeWith(
			project.publicKey,
			project.id,
			{ message: bigPayload },
			crypto.randomUUID().replace(/-/g, ''),
		);
		const compressed = await gzip(new TextEncoder().encode(body));
		const response = await postEnvelope(project, compressed, { 'Content-Encoding': 'gzip' });
		expect(response.status).toBe(400);
	});

	it('accepts legitimate gzip envelopes under the cap', async () => {
		const user = await createTestUser({
			email: `gz-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Gzip User',
		});
		const project = await createTestProject(user.token!, { name: `Gzip ${Date.now()}` });

		const body = envelopeWith(
			project.publicKey,
			project.id,
			{ exception: { type: 'Error', value: 'gz ok' } },
			crypto.randomUUID().replace(/-/g, ''),
		);
		const compressed = await gzip(new TextEncoder().encode(body));
		const response = await postEnvelope(project, compressed, { 'Content-Encoding': 'gzip' });
		expect(response.ok).toBe(true);
	});

	it('rejects envelopes with malformed item headers', async () => {
		const user = await createTestUser({
			email: `mal-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Malformed User',
		});
		const project = await createTestProject(user.token!, { name: `Mal ${Date.now()}` });

		const body = [
			JSON.stringify({
				event_id: crypto.randomUUID().replace(/-/g, ''),
				dsn: `https://${project.publicKey}@localhost/${project.id}`,
			}),
			'this is not json',
			'{}',
		].join('\n');
		const response = await postEnvelope(project, body);
		expect(response.status).toBe(400);
	});

	it('rejects envelopes with more than 20 items', async () => {
		const user = await createTestUser({
			email: `many-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Many User',
		});
		const project = await createTestProject(user.token!, { name: `Many ${Date.now()}` });

		const lines = [JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` })];
		for (let i = 0; i < 25; i++) {
			lines.push(JSON.stringify({ type: 'event' }));
			lines.push(
				JSON.stringify({ event_id: crypto.randomUUID().replace(/-/g, ''), message: `item ${i}` }),
			);
		}
		const response = await postEnvelope(project, lines.join('\n'));
		expect(response.status).toBe(400);
	});

	it('replaces invalid event ids and timestamps with server values', async () => {
		const user = await createTestUser({
			email: `valid-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Validation User',
		});
		const project = await createTestProject(user.token!, { name: `Valid ${Date.now()}` });

		const body = envelopeWith(
			project.publicKey,
			project.id,
			{
				level: 'bogus',
				timestamp: '1999-01-01T00:00:00.000Z',
				exception: { type: 'Error', value: 'id validation' },
			},
			'not-a-valid-id',
		);
		const response = await postEnvelope(project, body);
		expect(response.ok).toBe(true);
		const data = (await response.json()) as { id: string | null };
		expect(data.id).toMatch(/^[0-9a-f]{32}$/);
		expect(data.id).not.toBe('not-a-valid-id');
	});

	it('treats duplicate event ids as idempotent replays', async () => {
		const user = await createTestUser({
			email: `dup-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Dup User',
		});
		const project = await createTestProject(user.token!, { name: `Dup ${Date.now()}` });

		const eventId = crypto.randomUUID().replace(/-/g, '');
		const body = envelopeWith(
			project.publicKey,
			project.id,
			{ exception: { type: 'Error', value: 'dup probe' } },
			eventId,
		);
		const first = await postEnvelope(project, body);
		expect(first.ok).toBe(true);
		const second = await postEnvelope(project, body);
		expect(second.ok).toBe(true);
		const data = (await second.json()) as { id: string | null; duplicate?: boolean };
		expect(data.id).toBe(eventId);
		expect(data.duplicate).toBe(true);

		// Issue count did not double
		const issues = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const issuesData = (await issues.json()) as { issues?: Array<{ count: number }> };
		const list = issuesData.issues ?? (issuesData as unknown as Array<{ count: number }>);
		expect(list.length).toBe(1);
		expect(list[0].count).toBe(1);
	});

	it('accepts lowercase sentry auth scheme and padded values', async () => {
		const user = await createTestUser({
			email: `lc-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Lowercase User',
		});
		const project = await createTestProject(user.token!, { name: `LC ${Date.now()}` });

		const body = envelopeWith(
			project.publicKey,
			project.id,
			{ exception: { type: 'Error', value: 'lowercase auth' } },
			crypto.randomUUID().replace(/-/g, ''),
		);
		const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `sentry sentry_version=7, sentry_key = ${project.publicKey} , sentry_client=test/1.0`,
			},
			body,
		});
		expect(response.ok).toBe(true);
	});
});
