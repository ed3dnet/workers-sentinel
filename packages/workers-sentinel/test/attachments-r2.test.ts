import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EnvelopeFormatError } from '../src/lib/envelope-framer';
import { parseEnvelope } from '../src/lib/envelope-parser';
import { authFetch, createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

type TestProject = Awaited<ReturnType<typeof createTestProject>>;

const MIB = 1024 * 1024;
const ENVELOPE_ATTACHMENT_CAP = 21 * MIB; // 22,020,096 bytes
const WIRE_CAP = 27 * MIB;

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
	withLength = true,
): Array<string | Uint8Array> {
	const bytes = typeof data === 'string' ? enc.encode(data) : data;
	const header: Record<string, unknown> = {
		type: 'attachment',
		filename,
		content_type: contentType,
	};
	if (withLength) header.length = bytes.byteLength;
	return [JSON.stringify(header), '\n', bytes, '\n'];
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(data.buffer as ArrayBuffer).body!.pipeThrough(
		new CompressionStream('gzip'),
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function postEnvelope(
	project: TestProject,
	body: Uint8Array,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			...extraHeaders,
		},
		body: body as unknown as BodyInit,
	});
}

/** Deterministic non-UTF-8 pattern of `size` bytes. */
function pattern(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		out[i] = i % 251;
	}
	return out;
}

/** Byte-identical comparison with early mismatch report (memory-safe). */
function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
	expect(actual.byteLength).toBe(expected.byteLength);
	for (let i = 0; i < actual.byteLength; i++) {
		if (actual[i] !== expected[i]) {
			throw new Error(`byte mismatch at ${i}: ${actual[i]} != ${expected[i]}`);
		}
	}
}

async function listKeys(prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await env.ATTACHMENTS.list({ prefix, cursor });
		keys.push(...page.objects.map((o) => o.key));
		if (!page.truncated) return keys;
		cursor = page.cursor;
	}
}

function projectStub(projectId: string) {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
}

async function listAttachments(token: string, slug: string, eventId: string) {
	const response = await authFetch(
		token,
		`http://localhost/api/projects/${slug}/events/${eventId}/attachments`,
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { attachments: Array<{ id: string; size: number }> };
}

describe('attachments in R2', () => {
	let testUser: Awaited<ReturnType<typeof createTestUser>>;

	beforeAll(async () => {
		testUser = await createTestUser({
			email: `r2-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'R2 User',
		});
	});

	it('DO↔R2 binding probe: put/head/get/list/delete from inside the DO', async () => {
		const project = await createTestProject(testUser.token!, { name: `Probe ${Date.now()}` });
		const response = await projectStub(project.id).fetch('http://internal/attachment/r2-probe');
		expect(response.status).toBe(200);
		const data = (await response.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it('fault injection mechanism: X-Sentinel-Test-Fault put fails the intended operation', async () => {
		const project = await createTestProject(testUser.token!, { name: `Fault ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const response = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'fault probe'),
				...attachmentItem('f.txt', 'faulted'),
			]),
			{ 'X-Sentinel-Test-Fault': 'put' },
		);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe('attachment_storage_failed');
		expect(response.headers.get('Retry-After')).toBe('5');
	});

	it('round-trips a 21 MiB binary attachment byte-identically (AC.1)', async () => {
		const project = await createTestProject(testUser.token!, { name: `Big Bin ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const payload = pattern(ENVELOPE_ATTACHMENT_CAP); // exactly at the cap

		const response = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'big binary attachment'),
				...attachmentItem('heap.bin', payload, 'application/octet-stream'),
			]),
		);
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			id: string | null;
			droppedAttachments: Array<{ reason: string }>;
		};
		expect(data.id).toBe(eventId);
		expect(data.droppedAttachments).toEqual([]);

		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.attachments).toHaveLength(1);
		expect(list.attachments[0].size).toBe(ENVELOPE_ATTACHMENT_CAP);

		const download = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`,
		);
		expect(download.status).toBe(200);
		expect(download.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(download.headers.get('Content-Disposition')).toContain('heap.bin');
		assertBytesEqual(new Uint8Array(await download.arrayBuffer()), payload);
	}, 120_000);

	it('caps and bombs (AC.2)', async () => {
		// Single attachment one byte over the 21 MiB cap: nonfatal drop,
		// event still stored, blob never uploaded
		{
			const project = await createTestProject(testUser.token!, { name: `Cap1 ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'single over cap'),
					...attachmentItem('over.bin', pattern(ENVELOPE_ATTACHMENT_CAP + 1)),
				]),
			);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([{ filename: 'over.bin', reason: 'too_large' }]);
			const stored = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/events/${eventId}`,
			);
			expect(stored.status).toBe(200);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// Envelope total over the cap with ≤10 attachments: the attachment
		// that crosses 21 MiB drops with too_large, earlier ones store
		{
			const project = await createTestProject(testUser.token!, { name: `CapT ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const chunk = pattern(Math.round(2.2 * MIB));
			const parts: Array<string | Uint8Array> = [
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'envelope total over cap'),
			];
			for (let i = 0; i < 10; i++) {
				parts.push(...attachmentItem(`t-${i}.bin`, chunk));
			}
			const response = await postEnvelope(project, frame(parts));
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([{ filename: 't-9.bin', reason: 'too_large' }]);
			const list = await listAttachments(testUser.token!, project.slug, eventId);
			expect(list.attachments).toHaveLength(9);
		}

		// The 11th attachment drops with too_many
		{
			const project = await createTestProject(testUser.token!, { name: `CapN ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const parts: Array<string | Uint8Array> = [
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'too many'),
			];
			for (let i = 0; i < 11; i++) {
				parts.push(...attachmentItem(`n-${i}.txt`, `x${i}`));
			}
			const response = await postEnvelope(project, frame(parts));
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([{ filename: 'n-10.txt', reason: 'too_many' }]);
		}

		// A fully budget-compliant envelope sent UNCOMPRESSED is never
		// wire-rejected: 21 MiB attachment + ordinary event, no gzip
		{
			const project = await createTestProject(testUser.token!, { name: `CapU ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'budget compliant uncompressed'),
					...attachmentItem('u.bin', pattern(ENVELOPE_ATTACHMENT_CAP)),
				]),
			);
			expect(response.status).toBe(200);
			const data = (await response.json()) as { droppedAttachments: unknown[] };
			expect(data.droppedAttachments).toEqual([]);
		}

		// Wire body over 27 MiB → 413 (Content-Length precheck)
		{
			const project = await createTestProject(testUser.token!, { name: `CapW ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'wire over cap'),
					...attachmentItem('w.bin', pattern(WIRE_CAP)),
				]),
			);
			expect(response.status).toBe(413);
		}

		// Gzip bomb: decompressed bytes past the 64 MiB ceiling via a
		// discarded oversized attachment → 413
		{
			const project = await createTestProject(testUser.token!, { name: `Bomb ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const inner = frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'gzip bomb'),
				...attachmentItem('bomb.bin', new Uint8Array(65 * MIB)),
			]);
			const response = await postEnvelope(project, await gzip(inner), {
				'Content-Encoding': 'gzip',
			});
			expect(response.status).toBe(413);
		}

		// Giant blank separators inflate the decompressed body past the
		// ceiling → 413
		{
			const project = await createTestProject(testUser.token!, { name: `Sep ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const inner = frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'separator bomb'),
				'\n'.repeat(70 * MIB),
			]);
			const response = await postEnvelope(project, await gzip(inner), {
				'Content-Encoding': 'gzip',
			});
			expect(response.status).toBe(413);
		}

		// Envelope-header line over 64 KiB → 400
		{
			const project = await createTestProject(testUser.token!, { name: `HLine ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					`{"event_id":"${eventId}","pad":"${'a'.repeat(70 * 1024)}"}`,
					'\n',
					...eventItem(eventId, 'huge header line'),
				]),
			);
			expect(response.status).toBe(400);
		}

		// Item-header line over 64 KiB → 400
		{
			const project = await createTestProject(testUser.token!, { name: `ILine ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					`{"type":"attachment","filename":"${'b'.repeat(70 * 1024)}"}`,
					'\n',
				]),
			);
			expect(response.status).toBe(400);
		}

		// Unknown-length attachment over 1 MiB → nonfatal too_large
		{
			const project = await createTestProject(testUser.token!, { name: `NoLen ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'length-less oversized'),
					...attachmentItem('nolen.txt', 'z'.repeat(MIB + 1), 'text/plain', false),
				]),
			);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([{ filename: 'nolen.txt', reason: 'too_large' }]);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// Length-less binary truncates at the first newline by protocol; the
		// following bytes then fail to parse as an item header → 400
		{
			const project = await createTestProject(testUser.token!, { name: `BinNL ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const binary = new Uint8Array([0xff, 0xfe, 0x0a, 0x80, 0x81, 0x82]);
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'binary without length'),
					...attachmentItem('raw.bin', binary, 'application/octet-stream', false),
				]),
			);
			expect(response.status).toBe(400);
			const stored = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/events/${eventId}`,
			);
			expect(stored.status).toBe(404);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}
	}, 300_000);

	it('storage failure fails the whole ingest (503) — first put and later put (AC.3)', async () => {
		// maxEventsPerHour=1: a 503 abort must not consume quota, so the
		// clean retry succeeds
		const project = await createTestProject(testUser.token!, { name: `Fail1 ${Date.now()}` });
		await authFetch(testUser.token!, `http://localhost/api/projects/${project.slug}`, {
			method: 'PATCH',
			body: JSON.stringify({ maxEventsPerHour: 1 }),
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');

		const failing = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'storage failure probe'),
				...attachmentItem('first.txt', 'first payload'),
			]),
			{ 'X-Sentinel-Test-Fault': 'put' },
		);
		expect(failing.status).toBe(503);
		expect(((await failing.json()) as { error?: string }).error ?? '').toBe(
			'attachment_storage_failed',
		);

		// No event, no metadata, no blob, no quota consumption
		const stored = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(stored.status).toBe(404);
		expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		const rate = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/rate-limit`,
		);
		expect(((await rate.json()) as { currentHourCount: number }).currentHourCount).toBe(0);

		// Clean retry with the same event id succeeds
		const retry = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'storage failure probe'),
				...attachmentItem('first.txt', 'first payload'),
			]),
		);
		expect(retry.status).toBe(200);

		// put-after:1 — the first attachment uploads, the second fails; the
		// already-uploaded blob is deleted by the abort path
		const second = await createTestProject(testUser.token!, { name: `Fail2 ${Date.now()}` });
		const eventId2 = crypto.randomUUID().replace(/-/g, '');
		const failingLater = await postEnvelope(second, project2Envelope(second, eventId2), {
			'X-Sentinel-Test-Fault': 'put-after:1',
		});
		expect(failingLater.status).toBe(503);
		expect(await listKeys(`p/${second.id}/`)).toEqual([]);
		const stored2 = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${second.slug}/events/${eventId2}`,
		);
		expect(stored2.status).toBe(404);
	}, 120_000);

	it('truncated attachment framing stays 400 (AC.3)', async () => {
		const project = await createTestProject(testUser.token!, { name: `Trunc ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const response = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'truncated attachment'),
				JSON.stringify({ type: 'attachment', filename: 't.bin', length: 100 }),
				'\n',
				enc.encode('short'),
			]),
		);
		expect(response.status).toBe(400);
		const stored = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(stored.status).toBe(404);
		expect(await listKeys(`p/${project.id}/`)).toEqual([]);
	});

	it('shared non-attachment budget: many individually-small events exceeding 5 MiB total → 400', async () => {
		const project = await createTestProject(testUser.token!, { name: `Shared ${Date.now()}` });
		const parts: Array<string | Uint8Array> = [
			envelopeHeader(project, crypto.randomUUID().replace(/-/g, '')),
			'\n',
		];
		// 12 events × ~512 KiB each: every item is under the per-item bound,
		// but the request-wide shared budget (5 MiB) is exceeded
		const bigMessage = 'm'.repeat(512 * 1024);
		for (let i = 0; i < 12; i++) {
			const eventId = crypto.randomUUID().replace(/-/g, '');
			parts.push(
				JSON.stringify({ type: 'event' }),
				'\n',
				enc.encode(
					JSON.stringify({
						event_id: eventId,
						timestamp: new Date().toISOString(),
						platform: 'javascript',
						message: bigMessage,
					}),
				),
				'\n',
			);
		}
		const response = await postEnvelope(project, frame(parts));
		expect(response.status).toBe(400);
		// Nothing was stored: no events at all
		const issues = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const issuesData = (await issues.json()) as { issues: unknown[] };
		expect(issuesData.issues ?? []).toHaveLength(0);
	});

	it('purge_pending rejects a real-route envelope ingest with 503 and cleans blobs', async () => {
		const project = await createTestProject(testUser.token!, { name: `Purge503 ${Date.now()}` });
		const stub = projectStub(project.id);

		// Start a pending purge (faulted sweep keeps the project's DO alive;
		// the project itself remains registered, so DSN auth still works)
		const pending = await stub.fetch('http://internal/purge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: project.id, fault: 'purge-sweep' }),
		});
		expect(((await pending.json()) as { pending?: boolean }).pending ?? false).toBe(true);

		// A real envelope ingest with an attachment: the blob uploads, then
		// the DO ingest boundary rejects with purge_pending and the worker
		// must surface 503 (never an ack) and delete the blob
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const response = await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'ingest during pending purge'),
				...attachmentItem('p.txt', 'purge race'),
			]),
		);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error?: string };
		expect(body.error).toBe('purge_pending');
		expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		const stored = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(stored.status).toBe(404);

		// Finish the purge so later suites see a clean project
		await runDurableObjectAlarm(stub);
	});

	it('retry is idempotent; GC removes only expired orphans (AC.4)', async () => {
		const project = await createTestProject(testUser.token!, { name: `GC ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const payload = pattern(64 * 1024);
		const bytes = frame([
			envelopeHeader(project, eventId),
			'\n',
			...eventItem(eventId, 'gc probe'),
			...attachmentItem('gc.bin', payload),
		]);

		const first = await postEnvelope(project, bytes);
		expect(first.status).toBe(200);
		const resend = await postEnvelope(project, bytes);
		expect(resend.status).toBe(200);
		const resendData = (await resend.json()) as { duplicate?: boolean };
		expect(resendData.duplicate).toBe(true);

		// Original blob bytes unchanged; the resend's nonce-keyed blob was
		// deleted by the duplicate path (one object total)
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.attachments).toHaveLength(1);
		const keys = await listKeys(`p/${project.id}/`);
		expect(keys).toHaveLength(1);
		const download = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`,
		);
		assertBytesEqual(new Uint8Array(await download.arrayBuffer()), payload);

		// GC with a shifted clock: an orphan past the 1-hour grace is removed
		// while the referenced key survives. Only direct bucket access while
		// the clock is shifted (no authed HTTP). A second alarm run at real
		// time then shows a freshly-uploaded orphan is inside the grace.
		const stub = projectStub(project.id);
		const expiredOrphan = `p/${project.id}/u/expired-orphan/0`;
		await env.ATTACHMENTS.put(expiredOrphan, enc.encode('old'));
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
			await runDurableObjectAlarm(stub);
			expect(await env.ATTACHMENTS.head(expiredOrphan)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
		const freshOrphan = `p/${project.id}/u/fresh-orphan/0`;
		await env.ATTACHMENTS.put(freshOrphan, enc.encode('new'));
		await runDurableObjectAlarm(stub);
		expect(await env.ATTACHMENTS.head(freshOrphan)).not.toBeNull();

		// Clock restored: the referenced blob still downloads byte-identically
		const after = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`,
		);
		expect(after.status).toBe(200);
		assertBytesEqual(new Uint8Array(await after.arrayBuffer()), payload);
	}, 120_000);

	it('policy drops clean up their blobs; budget defaults and usage counter (AC.5)', async () => {
		// no_unique_event: zero events + one attachment — the blob uploads
		// (attachments may precede the event) and is deleted by the worker
		{
			const project = await createTestProject(testUser.token!, { name: `NoEvt ${Date.now()}` });
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, crypto.randomUUID().replace(/-/g, '')),
					'\n',
					...attachmentItem('orphan.txt', 'uploaded then dropped'),
				]),
			);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				id: string | null;
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.id).toBeNull();
			expect(data.droppedAttachments).toEqual([
				{ filename: 'orphan.txt', reason: 'no_unique_event' },
			]);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// event_filtered: filter drops the event; the uploaded blob is deleted
		{
			const project = await createTestProject(testUser.token!, { name: `Filt ${Date.now()}` });
			await authFetch(testUser.token!, `http://localhost/api/projects/${project.slug}/filters`, {
				method: 'POST',
				body: JSON.stringify({ filterType: 'message', pattern: 'r2-filtered-event' }),
			});
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const response = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'r2-filtered-event should drop'),
					...attachmentItem('gone.bin', pattern(2048)),
				]),
			);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				droppedAttachments: Array<{ reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([{ filename: 'gone.bin', reason: 'event_filtered' }]);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// project_attachment_quota: over-budget blob deleted, reason reported
		{
			const project = await createTestProject(testUser.token!, { name: `Quota ${Date.now()}` });
			await authFetch(testUser.token!, `http://localhost/api/projects/${project.slug}`, {
				method: 'PATCH',
				body: JSON.stringify({ maxAttachmentBytes: 100 }),
			});
			const firstId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				frame([
					envelopeHeader(project, firstId),
					'\n',
					...eventItem(firstId, 'quota first'),
					...attachmentItem('a.bin', pattern(100)),
				]),
			);
			const secondId = crypto.randomUUID().replace(/-/g, '');
			const second = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, secondId),
					'\n',
					...eventItem(secondId, 'quota second'),
					...attachmentItem('b.bin', pattern(50)),
				]),
			);
			const data = (await second.json()) as {
				droppedAttachments: Array<{ filename: string; reason: string }>;
			};
			expect(data.droppedAttachments).toEqual([
				{ filename: 'b.bin', reason: 'project_attachment_quota' },
			]);
			// The over-budget blob was deleted; the committed one remains
			const keys = await listKeys(`p/${project.id}/`);
			expect(keys).toHaveLength(1);

			// Usage counter equals SUM(size) across requests and survives an
			// alarm recompute: the boundary still holds exactly at 100 bytes
			await runDurableObjectAlarm(projectStub(project.id));
			const thirdId = crypto.randomUUID().replace(/-/g, '');
			const exactly = await postEnvelope(
				project,
				frame([
					envelopeHeader(project, thirdId),
					'\n',
					...eventItem(thirdId, 'quota third'),
					...attachmentItem('c.bin', pattern(50)),
				]),
			);
			expect(
				((await exactly.json()) as { droppedAttachments: unknown[] }).droppedAttachments,
			).toEqual([{ filename: 'c.bin', reason: 'project_attachment_quota' }]);
		}

		// Budget defaults to 10 GiB; the maxAttachmentRows PATCH field is gone
		{
			const project = await createTestProject(testUser.token!, { name: `Def ${Date.now()}` });
			const patch = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}`,
				{ method: 'PATCH', body: JSON.stringify({ maxEventsPerHour: 0 }) },
			);
			expect(patch.status).toBe(200);
			const data = (await patch.json()) as { config: { maxAttachmentBytes: number } };
			expect(data.config.maxAttachmentBytes).toBe(10 * 1024 * 1024 * 1024);

			const stale = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}`,
				{ method: 'PATCH', body: JSON.stringify({ maxAttachmentRows: 5 }) },
			);
			expect(stale.status).toBe(400);
		}
	}, 180_000);

	it('lifecycle deletes remove blobs from the bucket (AC.6)', async () => {
		// Single issue delete
		{
			const project = await createTestProject(testUser.token!, { name: `LD1 ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'lifecycle single'),
					...attachmentItem('del.bin', pattern(1024)),
				]),
			);
			expect((await listKeys(`p/${project.id}/`)).length).toBe(1);
			const issues = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/issues`,
			);
			const issueId = ((await issues.json()) as { issues: Array<{ id: string }> }).issues[0].id;
			const del = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/issues/${issueId}`,
				{ method: 'DELETE' },
			);
			expect(del.status).toBe(200);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// Bulk delete
		{
			const project = await createTestProject(testUser.token!, { name: `LDB ${Date.now()}` });
			for (const message of ['bulk a', 'bulk b']) {
				const eventId = crypto.randomUUID().replace(/-/g, '');
				await postEnvelope(
					project,
					frame([
						envelopeHeader(project, eventId),
						'\n',
						...eventItem(eventId, message),
						...attachmentItem(`${message.replace(' ', '-')}.bin`, pattern(512)),
					]),
				);
			}
			expect((await listKeys(`p/${project.id}/`)).length).toBe(2);
			const issues = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/issues`,
			);
			const ids = ((await issues.json()) as { issues: Array<{ id: string }> }).issues.map(
				(i) => i.id,
			);
			const bulk = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/issues/bulk`,
				{ method: 'PATCH', body: JSON.stringify({ issueIds: ids, action: 'delete' }) },
			);
			expect(bulk.status).toBe(200);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// Retention alarm
		{
			const project = await createTestProject(testUser.token!, { name: `LDR ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'lifecycle retention'),
					...attachmentItem('aged.bin', pattern(256)),
				]),
			);
			expect((await listKeys(`p/${project.id}/`)).length).toBe(1);
			await authFetch(testUser.token!, `http://localhost/api/projects/${project.slug}`, {
				method: 'PATCH',
				body: JSON.stringify({ retentionDays: 30 }),
			});
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
				await runDurableObjectAlarm(projectStub(project.id));
			} finally {
				vi.useRealTimers();
			}
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}

		// Purge via the DO (happy path)
		{
			const project = await createTestProject(testUser.token!, { name: `LDP ${Date.now()}` });
			const eventId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				frame([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(eventId, 'lifecycle purge'),
					...attachmentItem('purged.bin', pattern(128)),
				]),
			);
			expect((await listKeys(`p/${project.id}/`)).length).toBe(1);
			const purged = await projectStub(project.id).fetch('http://internal/purge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: project.id }),
			});
			expect(purged.status).toBe(200);
			expect(((await purged.json()) as { purged?: boolean }).purged ?? false).toBe(true);
			expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		}
	}, 180_000);

	it('purge retries its R2 sweep and rejects ingests while pending (AC.6)', async () => {
		const project = await createTestProject(testUser.token!, { name: `PurgeR ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'purge retry'),
				...attachmentItem('p.bin', pattern(300)),
			]),
		);
		expect((await listKeys(`p/${project.id}/`)).length).toBe(1);

		const stub = projectStub(project.id);
		// Sweep fault: purge cannot complete, stays pending
		const pending = await stub.fetch('http://internal/purge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: project.id, fault: 'purge-sweep' }),
		});
		expect(pending.status).toBe(200);
		expect(((await pending.json()) as { pending?: boolean }).pending ?? false).toBe(true);
		expect((await listKeys(`p/${project.id}/`)).length).toBe(1); // blob survives

		// While pending, ingest is rejected with 503
		const blocked = await stub.fetch('http://internal/ingest', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event_id: crypto.randomUUID().replace(/-/g, ''),
				timestamp: new Date().toISOString(),
				platform: 'javascript',
				message: 'should be blocked while purging',
			}),
		});
		expect(blocked.status).toBe(503);

		// The alarm retries the sweep, then wipes DO state
		await runDurableObjectAlarm(stub);
		expect(await listKeys(`p/${project.id}/`)).toEqual([]);
		const event = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(event.status).toBe(404);

		// Post-purge ingest works again (schema recreated lazily)
		const afterId = crypto.randomUUID().replace(/-/g, '');
		const after = await postEnvelope(
			project,
			frame([envelopeHeader(project, afterId), '\n', ...eventItem(afterId, 'after purge')]),
		);
		expect(after.status).toBe(200);
	}, 120_000);

	it('range and missing-blob download (AC.7)', async () => {
		const project = await createTestProject(testUser.token!, { name: `Range ${Date.now()}` });
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const payload = pattern(4096);
		await postEnvelope(
			project,
			frame([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(eventId, 'range request'),
				...attachmentItem('range.bin', payload),
			]),
		);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		const url = `http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`;

		// 206 with the exact byte slice
		const partial = await authFetch(testUser.token!, url, { headers: { Range: 'bytes=100-115' } });
		expect(partial.status).toBe(206);
		expect(partial.headers.get('Content-Range')).toBe('bytes 100-115/4096');
		assertBytesEqual(new Uint8Array(await partial.arrayBuffer()), payload.subarray(100, 116));

		// Suffix range
		const suffix = await authFetch(testUser.token!, url, { headers: { Range: 'bytes=-8' } });
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get('Content-Range')).toBe('bytes 4088-4095/4096');
		assertBytesEqual(new Uint8Array(await suffix.arrayBuffer()), payload.subarray(4088));

		// Unsatisfiable → 416 with the total size
		const unsat = await authFetch(testUser.token!, url, { headers: { Range: 'bytes=5000-' } });
		expect(unsat.status).toBe(416);
		expect(unsat.headers.get('Content-Range')).toBe('bytes */4096');

		// Zero-byte attachment: any range is unsatisfiable (never a
		// zero-length 206 with an invalid Content-Range)
		{
			const emptyId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				frame([
					envelopeHeader(project, emptyId),
					'\n',
					...eventItem(emptyId, 'zero byte range'),
					...attachmentItem('empty.bin', ''),
				]),
			);
			const emptyList = await listAttachments(testUser.token!, project.slug, emptyId);
			const emptyUrl = `http://localhost/api/projects/${project.slug}/attachments/${emptyList.attachments[0].id}`;
			const emptyRange = await authFetch(testUser.token!, emptyUrl, {
				headers: { Range: 'bytes=-1' },
			});
			expect(emptyRange.status).toBe(416);
			expect(emptyRange.headers.get('Content-Range')).toBe('bytes */0');
		}

		// Metadata exists, blob gone → distinct 404
		const objects = await env.ATTACHMENTS.list({ prefix: `p/${project.id}/` });
		const target = objects.objects.find((o) => o.size === 4096);
		expect(target).toBeDefined();
		await env.ATTACHMENTS.delete(target!.key);
		const missing = await authFetch(testUser.token!, url);
		expect(missing.status).toBe(404);
		expect(((await missing.json()) as { error: string }).error).toBe('attachment_data_missing');
	}, 120_000);

	it('inline migration converts legacy rows and handles delete-during-put (AC.9)', async () => {
		const project = await createTestProject(testUser.token!, { name: `Mig ${Date.now()}` });
		const stub = projectStub(project.id);

		// Legacy inline row via the internal boundary (pre-upgrade shape);
		// projectId is passed so alarm-driven work knows the key prefix
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const legacy = await stub.fetch('http://internal/ingest-with-attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				projectId: project.id,
				event: {
					event_id: eventId,
					timestamp: new Date().toISOString(),
					platform: 'javascript',
					level: 'error',
					message: 'legacy inline attachment',
				},
				attachments: [
					{ filename: 'legacy.log', contentType: 'text/plain', size: 13, data: 'legacy payload' },
				],
			}),
		});
		expect(legacy.status).toBe(200);
		const legacyResult = (await legacy.json()) as { storedR2Keys?: string[] };
		expect(legacyResult.storedR2Keys ?? []).toEqual([]);

		// Dual-read: serves from `data` before migration, no m/ object yet
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		const before = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`,
		);
		expect(before.status).toBe(200);
		expect(new TextDecoder().decode(new Uint8Array(await before.arrayBuffer()))).toBe(
			'legacy payload',
		);
		expect(await listKeys(`p/${project.id}/m/`)).toEqual([]);

		// Alarm migrates: deterministic m/ key, data='' sentinel
		await runDurableObjectAlarm(stub);
		const mKeys = await listKeys(`p/${project.id}/m/`);
		expect(mKeys).toHaveLength(1);
		expect(mKeys[0]).toBe(`p/${project.id}/m/${list.attachments[0].id}`);

		// Download now serves from R2 with identical bytes
		const after = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list.attachments[0].id}`,
		);
		expect(after.status).toBe(200);
		expect(new TextDecoder().decode(new Uint8Array(await after.arrayBuffer()))).toBe(
			'legacy payload',
		);

		// migration-flip fault: forces the flip to miss for the first row —
		// the just-uploaded blob is deleted and the row stays inline
		const eventId2 = crypto.randomUUID().replace(/-/g, '');
		await stub.fetch('http://internal/ingest-with-attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				projectId: project.id,
				event: {
					event_id: eventId2,
					timestamp: new Date().toISOString(),
					platform: 'javascript',
					level: 'error',
					message: 'flip fault target',
				},
				attachments: [
					{ filename: 'flip.log', contentType: 'text/plain', size: 10, data: 'flip target' },
				],
			}),
		});
		expect(await stub.fetch('http://internal/migration-flip-arm')).toBeInstanceOf(Response);
		await runDurableObjectAlarm(stub);
		// The first inline row was already migrated above; the flip applies to
		// the first row of THIS run — the blob it uploaded was deleted
		const list2 = await listAttachments(testUser.token!, project.slug, eventId2);
		expect(list2.attachments).toHaveLength(1);
		// Row still serves (inline data intact — the flip missed)
		const flipServed = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/attachments/${list2.attachments[0].id}`,
		);
		expect(flipServed.status).toBe(200);
		// The marker was consumed one-shot: a clean alarm run migrates it now
		await runDurableObjectAlarm(stub);
		expect((await listKeys(`p/${project.id}/m/`)).length).toBe(2);
	}, 120_000);

	it('framing golden corpus: expected structures from the collector (AC.8)', async () => {
		// Valid envelope: event + binary attachment + ignored item type
		const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
		const parsed = await parseEnvelope(
			frame([
				'{"event_id":"abc","dsn":"https://k@h/1"}',
				'\n',
				'{"type":"event"}',
				'\n',
				'{"event_id":"abc","message":"golden"}',
				'\n',
				JSON.stringify({ type: 'attachment', filename: 'b.bin', length: 4 }),
				'\n',
				binary,
				'\n',
				'{"type":"client_report"}',
				'\n',
				'{"timestamp":0}',
			]),
		);
		expect(parsed.header.event_id).toBe('abc');
		expect(parsed.items).toHaveLength(3);
		expect(parsed.items[0]).toMatchObject({ type: 'event', payload: { message: 'golden' } });
		expect(parsed.items[1].type).toBe('attachment');
		const attachmentPayload = parsed.items[1].payload;
		expect(attachmentPayload).toBeInstanceOf(Uint8Array);
		assertBytesEqual(attachmentPayload as Uint8Array, binary);
		expect(parsed.items[2].type).toBe('client_report');
		expect(typeof parsed.items[2].payload).toBe('string');

		// Blank separator lines tolerated; trailing newline optional
		const withBlanks = await parseEnvelope(
			frame(['{"dsn":"https://k@h/1"}', '\n', '   \r\n', '{"type":"event"}', '\n', '{}']),
		);
		expect(withBlanks.items).toHaveLength(1);

		// Malformed item header → EnvelopeFormatError
		await expect(parseEnvelope(frame(['{}', '\n', 'not json', '\n']))).rejects.toBeInstanceOf(
			EnvelopeFormatError,
		);

		// Valid-plus-malformed mixed envelope: rejected whole
		await expect(
			parseEnvelope(
				frame([
					'{}',
					'\n',
					'{"type":"event"}',
					'\n',
					'{"ok":true}',
					'\n',
					'{"type":"event"}',
					'\n',
					'{ bad',
				]),
			),
		).rejects.toBeInstanceOf(EnvelopeFormatError);

		// Truncated length-delimited payload
		await expect(
			parseEnvelope(frame(['{}', '\n', '{"type":"attachment","length":10}', '\n', 'short'])),
		).rejects.toBeInstanceOf(EnvelopeFormatError);

		// Misaligned boundary after a length-delimited payload
		await expect(
			parseEnvelope(frame(['{}', '\n', '{"type":"attachment","length":5}', '\n', 'abcde', 'X'])),
		).rejects.toBeInstanceOf(EnvelopeFormatError);

		// >20 items
		const manyParts: Array<string | Uint8Array> = ['{}', '\n'];
		for (let i = 0; i < 21; i++) {
			manyParts.push('{"type":"client_report"}', '\n', '{}', '\n');
		}
		await expect(parseEnvelope(frame(manyParts))).rejects.toBeInstanceOf(EnvelopeFormatError);

		// Empty body
		await expect(parseEnvelope(new Uint8Array(0))).rejects.toBeInstanceOf(EnvelopeFormatError);

		// Invalid UTF-8 in an item header
		await expect(
			parseEnvelope(frame(['{}', '\n', new Uint8Array([0xff, 0x7b]), '\n'])),
		).rejects.toBeInstanceOf(EnvelopeFormatError);
	});

	it('raw JSON store dispatch: plain, gzip, malformed UTF-8 (AC.8)', async () => {
		const project = await createTestProject(testUser.token!, { name: `Raw ${Date.now()}` });

		const post = (body: BodyInit, headers: Record<string, string> = {}) =>
			SELF.fetch(`http://localhost/api/${project.id}/store/`, {
				method: 'POST',
				headers: {
					'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
					...headers,
				},
				body,
			});

		// Plain JSON event
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const plain = await post(
			enc.encode(
				JSON.stringify({
					event_id: eventId,
					timestamp: new Date().toISOString(),
					platform: 'node',
					message: 'raw json store event',
				}),
			),
			{ 'Content-Type': 'application/json' },
		);
		expect(plain.status).toBe(200);
		expect(((await plain.json()) as { id: string | null }).id).toBe(eventId);

		// gzip'd JSON event
		const eventId2 = crypto.randomUUID().replace(/-/g, '');
		const gz = await gzip(
			enc.encode(
				JSON.stringify({
					event_id: eventId2,
					timestamp: new Date().toISOString(),
					platform: 'node',
					message: 'gzipped raw json store event',
				}),
			),
		);
		const compressed = await post(gz, {
			'Content-Type': 'application/json',
			'Content-Encoding': 'gzip',
		});
		expect(compressed.status).toBe(200);
		expect(((await compressed.json()) as { id: string | null }).id).toBe(eventId2);

		// Malformed UTF-8 body → 400
		const malformed = await post(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x7d]), {
			'Content-Type': 'application/json',
		});
		expect(malformed.status).toBe(400);

		// Same bytes as an envelope content-type → envelope framing error → 400
		const asEnvelope = await post(new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x7d]));
		expect(asEnvelope.status).toBe(400);
	}, 120_000);
});

/** Helper: build the put-after:1 failing request body as a real envelope. */
function project2Envelope(project: TestProject, eventId: string): Uint8Array {
	return frame([
		envelopeHeader(project, eventId),
		'\n',
		...eventItem(eventId, 'second attachment fails'),
		...attachmentItem('ok.txt', 'uploads fine'),
		...attachmentItem('boom.txt', 'this put fails'),
	]);
}
