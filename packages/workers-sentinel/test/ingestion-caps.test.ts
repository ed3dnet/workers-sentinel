import { env, SELF } from 'cloudflare:test';
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
	it('rejects bodies over the wire size limit with 413', async () => {
		const user = await createTestUser({
			email: `caps-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Caps User',
		});
		const project = await createTestProject(user.token!, { name: `Caps ${Date.now()}` });

		// 28 MiB exceeds the 27 MiB wire cap: a budget-compliant envelope
		// (21 MiB attachments + 5 MiB items + framing) is never wire-rejected
		const bigPayload = 'x'.repeat(28 * 1024 * 1024);
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

describe('event id round-trip and envelope framing', () => {
	const enc = new TextEncoder();

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

	function headerLine(project: { publicKey: string; id: string }, eventId: string): string {
		return JSON.stringify({
			event_id: eventId,
			dsn: `https://${project.publicKey}@localhost/${project.id}`,
		});
	}

	function eventItem(eventId: string, payload: Record<string, unknown> = {}): Array<string> {
		return [
			JSON.stringify({ type: 'event' }),
			'\n',
			JSON.stringify({
				event_id: eventId,
				timestamp: new Date().toISOString(),
				platform: 'javascript',
				...payload,
			}),
			'\n',
		];
	}

	async function postBytes(
		project: { id: string; publicKey: string },
		bytes: Uint8Array,
	): Promise<Response> {
		return SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: bytes as unknown as BodyInit,
		});
	}

	it('dashed UUID round-trips normalized; resend duplicate', async () => {
		const user = await createTestUser({
			email: `uuid-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'UUID User',
		});
		const project = await createTestProject(user.token!, { name: `UUID ${Date.now()}` });

		const dashed = crypto.randomUUID();
		const normalized = dashed.replace(/-/g, '');
		const bytes = frame([
			headerLine(project, dashed),
			'\n',
			...eventItem(dashed, { message: 'uuid round trip' }),
		]);

		const first = await postBytes(project, bytes);
		expect(first.ok).toBe(true);
		const firstData = (await first.json()) as { id: string | null; duplicate?: boolean };
		expect(firstData.id).toBe(normalized);

		// Event retrievable under the normalized id
		const stored = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${normalized}`,
		);
		expect(stored.status).toBe(200);

		// Dashed resend and stripped resend are both idempotent replays
		const dashedResend = await postBytes(project, bytes);
		const dashedData = (await dashedResend.json()) as { id: string | null; duplicate?: boolean };
		expect(dashedData.id).toBe(normalized);
		expect(dashedData.duplicate).toBe(true);

		const stripped = frame([
			headerLine(project, normalized),
			'\n',
			...eventItem(normalized, { message: 'uuid round trip' }),
		]);
		const strippedResend = await postBytes(project, stripped);
		const strippedData = (await strippedResend.json()) as {
			id: string | null;
			duplicate?: boolean;
		};
		expect(strippedData.id).toBe(normalized);
		expect(strippedData.duplicate).toBe(true);

		// Exactly one event was stored
		const issues = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const issuesData = (await issues.json()) as { issues: Array<{ count: number }> };
		expect(issuesData.issues).toHaveLength(1);
		expect(issuesData.issues[0].count).toBe(1);
	});

	it('uppercase dashed UUID event ids normalize too', async () => {
		const user = await createTestUser({
			email: `uuiduc-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'UUID Upper User',
		});
		const project = await createTestProject(user.token!, { name: `UUIDUC ${Date.now()}` });

		const upperDashed = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
		const normalized = 'abcdef1234567890abcdef1234567890';
		const response = await postBytes(
			project,
			frame([
				headerLine(project, upperDashed),
				'\n',
				...eventItem(upperDashed, { message: 'uppercase dashed uuid' }),
			]),
		);
		expect(response.ok).toBe(true);
		const data = (await response.json()) as { id: string | null };
		expect(data.id).toBe(normalized);

		// The lowercase stripped resend is a duplicate of the same event
		const resend = await postBytes(
			project,
			frame([
				headerLine(project, normalized),
				'\n',
				...eventItem(normalized, { message: 'uppercase dashed uuid' }),
			]),
		);
		const resendData = (await resend.json()) as { id: string | null; duplicate?: boolean };
		expect(resendData.id).toBe(normalized);
		expect(resendData.duplicate).toBe(true);
	});

	it('parses length-delimited items with and without final trailing newline', async () => {
		const user = await createTestUser({
			email: `nl-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Newline User',
		});
		const project = await createTestProject(user.token!, { name: `NL ${Date.now()}` });

		const eventIdA = crypto.randomUUID().replace(/-/g, '');
		const payloadA = enc.encode('with trailing newline');
		const withNewline = frame([
			headerLine(project, eventIdA),
			'\n',
			...eventItem(eventIdA, { message: 'framed with newline' }),
			JSON.stringify({
				type: 'attachment',
				filename: 'a.txt',
				content_type: 'text/plain',
				length: payloadA.byteLength,
			}),
			'\n',
			payloadA,
			'\n',
		]);
		const first = await postBytes(project, withNewline);
		expect(first.ok).toBe(true);

		// Same shape but the length-delimited payload ends exactly at EOF:
		// the final newline is optional per the envelope spec
		const eventIdB = crypto.randomUUID().replace(/-/g, '');
		const payloadB = enc.encode('ends at eof');
		const withoutNewline = frame([
			headerLine(project, eventIdB),
			'\n',
			...eventItem(eventIdB, { message: 'framed without newline' }),
			JSON.stringify({
				type: 'attachment',
				filename: 'b.txt',
				content_type: 'text/plain',
				length: payloadB.byteLength,
			}),
			'\n',
			payloadB,
		]);
		const second = await postBytes(project, withoutNewline);
		expect(second.ok).toBe(true);
		const secondData = (await second.json()) as { droppedAttachments: unknown[] };
		expect(secondData.droppedAttachments).toEqual([]);

		for (const [eventId, filename] of [
			[eventIdA, 'a.txt'],
			[eventIdB, 'b.txt'],
		] as const) {
			const list = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/events/${eventId}/attachments`,
			);
			expect(list.status).toBe(200);
			const data = (await list.json()) as { attachments: Array<{ filename: string }> };
			expect(data.attachments[0].filename).toBe(filename);
		}
	});

	it('empty payload items are valid', async () => {
		const user = await createTestUser({
			email: `empty-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Empty User',
		});
		const project = await createTestProject(user.token!, { name: `Empty ${Date.now()}` });

		const eventId = crypto.randomUUID().replace(/-/g, '');
		const bytes = frame([
			headerLine(project, eventId),
			'\n',
			...eventItem(eventId, { message: 'empty payloads' }),
			JSON.stringify({
				type: 'attachment',
				filename: 'empty.txt',
				content_type: 'text/plain',
				length: 0,
			}),
			'\n',
			new Uint8Array(0),
			'\n',
			JSON.stringify({ type: 'client_report', length: 0 }),
			'\n',
			new Uint8Array(0),
		]);
		const response = await postBytes(project, bytes);
		expect(response.ok).toBe(true);

		const list = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}/attachments`,
		);
		const data = (await list.json()) as { attachments: Array<{ id: string; size: number }> };
		expect(data.attachments).toHaveLength(1);
		expect(data.attachments[0].size).toBe(0);

		// The empty attachment downloads as zero bytes
		const download = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${data.attachments[0].id}`,
		);
		expect(download.status).toBe(200);
		expect(new Uint8Array(await download.arrayBuffer()).byteLength).toBe(0);
	});

	it('rejects truncated length and misaligned items', async () => {
		const user = await createTestUser({
			email: `trunc-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Truncated User',
		});
		const project = await createTestProject(user.token!, { name: `Trunc ${Date.now()}` });

		const eventId = crypto.randomUUID().replace(/-/g, '');

		// Declared length exceeds the remaining bytes
		const truncated = frame([
			headerLine(project, eventId),
			'\n',
			...eventItem(eventId, { message: 'truncated length' }),
			JSON.stringify({ type: 'attachment', filename: 't.txt', length: 100 }),
			'\n',
			enc.encode('short'),
		]);
		const truncatedResponse = await postBytes(project, truncated);
		expect(truncatedResponse.status).toBe(400);

		// Bytes follow a length-delimited payload without the required newline
		const misaligned = frame([
			headerLine(project, eventId),
			'\n',
			JSON.stringify({ type: 'attachment', filename: 'm.txt', length: 5 }),
			'\n',
			enc.encode('abcde'),
			enc.encode('garbage-without-newline'),
		]);
		const misalignedResponse = await postBytes(project, misaligned);
		expect(misalignedResponse.status).toBe(400);

		// Nothing was stored by either rejected envelope
		const event = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(event.status).toBe(404);
	});

	it('malformed header or event JSON returns 400', async () => {
		const user = await createTestUser({
			email: `maljson-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Malformed JSON User',
		});
		const project = await createTestProject(user.token!, { name: `MalJSON ${Date.now()}` });

		// Malformed-only: item payload is not valid JSON
		const malformed = frame([
			headerLine(project, 'mal1'),
			'\n',
			JSON.stringify({ type: 'event' }),
			'\n',
			enc.encode('{ not json'),
		]);
		const malformedResponse = await postBytes(project, malformed);
		expect(malformedResponse.status).toBe(400);

		// Valid-plus-malformed mixed envelope: rejected whole, nothing stored
		const goodId = crypto.randomUUID().replace(/-/g, '');
		const mixed = frame([
			headerLine(project, goodId),
			'\n',
			...eventItem(goodId, { message: 'the valid half' }),
			JSON.stringify({ type: 'event' }),
			'\n',
			enc.encode('{ also not json'),
		]);
		const mixedResponse = await postBytes(project, mixed);
		expect(mixedResponse.status).toBe(400);

		const goodEvent = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${goodId}`,
		);
		expect(goodEvent.status).toBe(404);
		const issues = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const issuesData = (await issues.json()) as { issues: unknown[] };
		expect(issuesData.issues).toHaveLength(0);
	});

	it('bare-event RPC ingest regression', async () => {
		const user = await createTestUser({
			email: `rpc-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'RPC User',
		});
		const project = await createTestProject(user.token!, { name: `RPC ${Date.now()}` });

		// The /ingest boundary the service-binding RPC path uses: a bare
		// SentryEvent JSON body, no {event, attachments} wrapper.
		const dashed = crypto.randomUUID();
		const normalized = dashed.replace(/-/g, '');
		const event = {
			event_id: dashed,
			timestamp: new Date().toISOString(),
			platform: 'node',
			level: 'warning',
			message: 'bare rpc event',
			tags: { region: 'eu-1', service: 'rpc-test' },
			user: { id: 'user-42', email: 'rpc@example.com' },
			environment: 'production',
		};

		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const ingest = await stub.fetch('http://internal/ingest', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(event),
		});
		expect(ingest.ok).toBe(true);
		const result = (await ingest.json()) as {
			eventId: string;
			issueId: string;
			isNewIssue: boolean;
			level: string;
		};
		expect(result.eventId).toBe(normalized);
		expect(result.isNewIssue).toBe(true);
		expect(result.level).toBe('warning');

		// Fields and ids preserved through storage
		const stored = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/events/${normalized}`,
		);
		expect(stored.status).toBe(200);
		const storedData = (await stored.json()) as { event: Record<string, unknown> };
		expect(storedData.event.event_id).toBe(normalized);
		expect(storedData.event.message).toBe('bare rpc event');
		expect(storedData.event.level).toBe('warning');
		expect((storedData.event.tags as Record<string, string>).region).toBe('eu-1');
		expect((storedData.event.user as { id?: string }).id).toBe('user-42');

		// The legacy store endpoint (raw JSON body over HTTP) still works
		const storeId = crypto.randomUUID();
		const storeResponse = await SELF.fetch(`http://localhost/api/${project.id}/store/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: JSON.stringify({
				event_id: storeId,
				timestamp: new Date().toISOString(),
				platform: 'node',
				message: 'legacy store event',
			}),
		});
		expect(storeResponse.ok).toBe(true);
		const storeData = (await storeResponse.json()) as {
			id: string | null;
			droppedAttachments: unknown[];
		};
		expect(storeData.id).toBe(storeId.replace(/-/g, ''));
		expect(storeData.droppedAttachments).toEqual([]);
	});
});
