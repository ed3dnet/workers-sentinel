import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { authFetch, createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

type TestProject = Awaited<ReturnType<typeof createTestProject>>;

function envelopeBytes(parts: Array<string | Uint8Array>): Uint8Array {
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

function eventItem(event: Record<string, unknown>): Array<string | Uint8Array> {
	return [JSON.stringify({ type: 'event' }), '\n', JSON.stringify(event), '\n'];
}

function baseEvent(eventId: string, message: string): Record<string, unknown> {
	return {
		event_id: eventId,
		timestamp: new Date().toISOString(),
		platform: 'javascript',
		level: 'error',
		message,
	};
}

function attachmentItem(
	filename: string,
	data: string | Uint8Array,
	contentType = 'text/plain',
	trailingNewline = true,
): Array<string | Uint8Array> {
	const bytes = typeof data === 'string' ? enc.encode(data) : data;
	const header = JSON.stringify({
		type: 'attachment',
		filename,
		content_type: contentType,
		length: bytes.byteLength,
	});
	return [header, '\n', bytes, ...(trailingNewline ? ['\n'] : [])];
}

interface IngestResponse {
	id?: string | null;
	duplicate?: boolean;
	droppedAttachments?: Array<{ filename: string; reason: string }>;
}

async function postEnvelope(
	project: TestProject,
	bytes: Uint8Array,
): Promise<{ status: number; data: IngestResponse }> {
	const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
		},
		body: bytes as unknown as BodyInit,
	});
	const text = await response.text();
	return { status: response.status, data: (text ? JSON.parse(text) : {}) as IngestResponse };
}

interface AttachmentMeta {
	id: string;
	eventId: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: string;
}

async function listAttachments(
	token: string,
	slug: string,
	eventId: string,
): Promise<{ status: number; issueId?: string; attachments: AttachmentMeta[] }> {
	const response = await authFetch(
		token,
		`http://localhost/api/projects/${slug}/events/${eventId}/attachments`,
	);
	if (!response.ok) {
		return { status: response.status, attachments: [] };
	}
	return {
		status: response.status,
		...((await response.json()) as { issueId?: string; attachments: AttachmentMeta[] }),
	};
}

async function downloadAttachment(
	token: string,
	slug: string,
	attachmentId: string,
): Promise<{ status: number; headers: Headers; bytes: Uint8Array | null }> {
	const response = await authFetch(
		token,
		`http://localhost/api/projects/${slug}/attachments/${attachmentId}`,
	);
	const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
	return { status: response.status, headers: response.headers, bytes };
}

async function getIssues(token: string, slug: string) {
	const response = await authFetch(token, `http://localhost/api/projects/${slug}/issues`);
	const data = (await response.json()) as { issues: Array<{ id: string; count: number }> };
	return data.issues ?? [];
}

async function setProjectConfig(
	token: string,
	slug: string,
	body: Record<string, unknown>,
): Promise<void> {
	const response = await authFetch(token, `http://localhost/api/projects/${slug}`, {
		method: 'PATCH',
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
}

describe('Attachments', () => {
	let testUser: Awaited<ReturnType<typeof createTestUser>>;

	beforeAll(async () => {
		testUser = await createTestUser({
			email: `attach-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Attachment User',
		});
	});

	it('round-trips a text attachment byte-identically', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Attach RT ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');

		const multiline = 'line one\nline two\nline three\n';
		const jsonish = '{\n  "kept":   "whitespace" ,\n}\n';
		const nonAscii = 'héllo wörld — 日本語テキスト 🛡️ end';
		const bom = '\uFEFFbom-prefixed log line\n';

		const bytes = envelopeBytes([
			envelopeHeader(project, eventId),
			'\n',
			...eventItem(baseEvent(eventId, 'attachment round-trip')),
			...attachmentItem('multiline.log', multiline),
			...attachmentItem('dump.json.txt', jsonish, 'application/json'),
			...attachmentItem('unicode.txt', nonAscii),
			...attachmentItem('bom.log', bom),
		]);

		const result = await postEnvelope(project, bytes);
		expect(result.status).toBe(200);
		expect(result.data.id).toBe(eventId);
		expect(result.data.droppedAttachments).toEqual([]);

		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.status).toBe(200);
		expect(list.attachments).toHaveLength(4);

		const originals = [multiline, jsonish, nonAscii, bom];
		for (let i = 0; i < originals.length; i++) {
			const download = await downloadAttachment(
				testUser.token!,
				project.slug,
				list.attachments[i].id,
			);
			expect(download.status).toBe(200);
			expect(download.bytes).toEqual(enc.encode(originals[i]));
		}

		// Non-ASCII byte accounting: size is the UTF-8 byte length, not the
		// UTF-16 code-unit length of the decoded string.
		expect(list.attachments[2].size).toBe(enc.encode(nonAscii).byteLength);
		expect(list.attachments[2].size).toBeGreaterThan(nonAscii.length);
		// BOM is preserved as attachment data, not stripped by decoding.
		expect(list.attachments[3].size).toBe(enc.encode(bom).byteLength);
		expect(list.attachments[1].contentType).toBe('application/json');
	});

	it('drop reasons: too_large / too_many / binary_unsupported / no_unique_event / event_filtered / project_attachment_quota / project_attachment_count', async () => {
		// too_large: byte length over 100 KiB (plain ASCII and the multibyte
		// case where UTF-16 length stays under the byte cap)
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Big ${Date.now()}`,
			});
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const result = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(baseEvent(eventId, 'too large ascii')),
					...attachmentItem('big.txt', 'a'.repeat(100 * 1024 + 1)),
				]),
			);
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'big.txt', reason: 'too_large' },
			]);
			// Event still stored
			const event = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/events/${eventId}`,
			);
			expect(event.status).toBe(200);
		}
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Big Uni ${Date.now()}`,
			});
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const multibyte = '🛡️'.repeat(26_000); // 26k UTF-16 units, 104k UTF-8 bytes
			const result = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(baseEvent(eventId, 'too large multibyte')),
					...attachmentItem('uni.txt', multibyte),
				]),
			);
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'uni.txt', reason: 'too_large' },
			]);
		}

		// too_many: the 11th attachment drops, the first ten store
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Many ${Date.now()}`,
			});
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const parts: Array<string | Uint8Array> = [
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'too many attachments')),
			];
			for (let i = 0; i < 11; i++) {
				parts.push(...attachmentItem(`att-${i}.txt`, `payload ${i}`));
			}
			const result = await postEnvelope(project, envelopeBytes(parts));
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'att-10.txt', reason: 'too_many' },
			]);
			const list = await listAttachments(testUser.token!, project.slug, eventId);
			expect(list.attachments).toHaveLength(10);
		}

		// binary_unsupported: invalid UTF-8 payload drops, the event in the
		// same mixed envelope still stores
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Bin ${Date.now()}`,
			});
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const binary = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x00, 0x80]);
			const result = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(baseEvent(eventId, 'mixed binary envelope')),
					...attachmentItem('screenshot.png', binary, 'image/png'),
					...attachmentItem('notes.txt', 'kept'),
				]),
			);
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'screenshot.png', reason: 'binary_unsupported' },
			]);
			const list = await listAttachments(testUser.token!, project.slug, eventId);
			expect(list.attachments).toHaveLength(1);
			expect(list.attachments[0].filename).toBe('notes.txt');
		}

		// no_unique_event: envelope with two events cannot associate the
		// attachment with an unambiguous owner
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop NoEvt ${Date.now()}`,
			});
			const eventIdA = crypto.randomUUID().replace(/-/g, '');
			const eventIdB = crypto.randomUUID().replace(/-/g, '');
			const result = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventIdA),
					'\n',
					...eventItem(baseEvent(eventIdA, 'first of two')),
					...eventItem(baseEvent(eventIdB, 'second of two')),
					...attachmentItem('orphan.txt', 'no owner'),
				]),
			);
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'orphan.txt', reason: 'no_unique_event' },
			]);
			for (const id of [eventIdA, eventIdB]) {
				const event = await authFetch(
					testUser.token!,
					`http://localhost/api/projects/${project.slug}/events/${id}`,
				);
				expect(event.status).toBe(200);
			}
		}

		// event_filtered: the inbound filter drops the event, its attachment
		// drops with it
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Filt ${Date.now()}`,
			});
			const create = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/filters`,
				{
					method: 'POST',
					body: JSON.stringify({
						filterType: 'message',
						pattern: 'filtered-attachment-event',
						description: 'drop these',
					}),
				},
			);
			expect(create.status).toBe(201);
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const result = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(baseEvent(eventId, 'please filtered-attachment-event go away')),
					...attachmentItem('gone.txt', 'filtered with the event'),
				]),
			);
			expect(result.status).toBe(200);
			expect(result.data.droppedAttachments).toEqual([
				{ filename: 'gone.txt', reason: 'event_filtered' },
			]);
			const list = await listAttachments(testUser.token!, project.slug, eventId);
			expect(list.status).toBe(404);
		}

		// project_attachment_quota / project_attachment_count: per-project
		// budgets drop non-fatally and never touch stored data
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Quota ${Date.now()}`,
			});
			await setProjectConfig(testUser.token!, project.slug, { maxAttachmentBytes: 10 });

			const firstId = crypto.randomUUID().replace(/-/g, '');
			const first = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, firstId),
					'\n',
					...eventItem(baseEvent(firstId, 'quota first')),
					...attachmentItem('first.txt', '12345'),
				]),
			);
			expect(first.data.droppedAttachments).toEqual([]);

			const secondId = crypto.randomUUID().replace(/-/g, '');
			const second = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, secondId),
					'\n',
					...eventItem(baseEvent(secondId, 'quota second')),
					...attachmentItem('second.txt', '123456'),
				]),
			);
			expect(second.status).toBe(200);
			expect(second.data.droppedAttachments).toEqual([
				{ filename: 'second.txt', reason: 'project_attachment_quota' },
			]);
			// Event stored despite the drop; the first attachment is untouched
			const event = await authFetch(
				testUser.token!,
				`http://localhost/api/projects/${project.slug}/events/${secondId}`,
			);
			expect(event.status).toBe(200);
			const list = await listAttachments(testUser.token!, project.slug, firstId);
			expect(list.attachments).toHaveLength(1);
			const download = await downloadAttachment(
				testUser.token!,
				project.slug,
				list.attachments[0].id,
			);
			expect(new TextDecoder().decode(download.bytes!)).toBe('12345');
		}
		{
			const project = await createTestProject(testUser.token!, {
				name: `Drop Count ${Date.now()}`,
			});
			await setProjectConfig(testUser.token!, project.slug, { maxAttachmentRows: 1 });

			const firstId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, firstId),
					'\n',
					...eventItem(baseEvent(firstId, 'count first')),
					// Zero-byte attachment: consumes a row, no bytes
					...attachmentItem('zero.txt', ''),
				]),
			);
			const secondId = crypto.randomUUID().replace(/-/g, '');
			const second = await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, secondId),
					'\n',
					...eventItem(baseEvent(secondId, 'count second')),
					...attachmentItem('over-row-cap.txt', ''),
				]),
			);
			expect(second.status).toBe(200);
			expect(second.data.droppedAttachments).toEqual([
				{ filename: 'over-row-cap.txt', reason: 'project_attachment_count' },
			]);
		}
	});

	it('budget boundaries: exact-limit accepted, over-limit dropped with reason, event still stored, existing attachments untouched', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Budget Edge ${Date.now()}`,
		});
		await setProjectConfig(testUser.token!, project.slug, { maxAttachmentBytes: 10 });

		// Byte boundary: exactly at the limit is accepted
		const exactId = crypto.randomUUID().replace(/-/g, '');
		const exact = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, exactId),
				'\n',
				...eventItem(baseEvent(exactId, 'exact budget')),
				...attachmentItem('exact.txt', '0123456789'),
			]),
		);
		expect(exact.data.droppedAttachments).toEqual([]);

		// One byte over (for the whole project now) is dropped
		const overId = crypto.randomUUID().replace(/-/g, '');
		const over = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, overId),
				'\n',
				...eventItem(baseEvent(overId, 'over budget')),
				...attachmentItem('over.txt', 'x'),
			]),
		);
		expect(over.status).toBe(200);
		expect(over.data.droppedAttachments).toEqual([
			{ filename: 'over.txt', reason: 'project_attachment_quota' },
		]);
		const overEvent = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${overId}`,
		);
		expect(overEvent.status).toBe(200);

		// Row boundary: exact rows accepted, next row dropped
		await setProjectConfig(testUser.token!, project.slug, { maxAttachmentRows: 2 });
		const rowExactId = crypto.randomUUID().replace(/-/g, '');
		const rowExact = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, rowExactId),
				'\n',
				...eventItem(baseEvent(rowExactId, 'row exact')),
				...attachmentItem('row-a.txt', ''),
			]),
		);
		expect(rowExact.data.droppedAttachments).toEqual([]);
		const rowOverId = crypto.randomUUID().replace(/-/g, '');
		const rowOver = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, rowOverId),
				'\n',
				...eventItem(baseEvent(rowOverId, 'row over')),
				...attachmentItem('row-b.txt', ''),
			]),
		);
		expect(rowOver.data.droppedAttachments).toEqual([
			{ filename: 'row-b.txt', reason: 'project_attachment_count' },
		]);
	});

	it('replay does not increase attachment count', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Replay ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const bytes = envelopeBytes([
			envelopeHeader(project, eventId),
			'\n',
			...eventItem(baseEvent(eventId, 'replay me')),
			...attachmentItem('replay.txt', 'replay payload'),
		]);
		const first = await postEnvelope(project, bytes);
		expect(first.status).toBe(200);
		const second = await postEnvelope(project, bytes);
		expect(second.status).toBe(200);
		expect(second.data.duplicate).toBe(true);

		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.attachments).toHaveLength(1);
		const issues = await getIssues(testUser.token!, project.slug);
		expect(issues).toHaveLength(1);
		expect(issues[0].count).toBe(1);
	});

	it('retention cascade removes attachments', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Retain ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const result = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'retention cascade')),
				...attachmentItem('aged.log', 'aged by retention'),
			]),
		);
		expect(result.status).toBe(200);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		const attachmentId = list.attachments[0].id;

		// Configure retention at real time first (the PATCH authenticates via
		// AuthState, whose session cleanup must not see the faked clock),
		// then fake the clock only for the alarm itself.
		await setProjectConfig(testUser.token!, project.slug, { retentionDays: 30 });
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
			await runDurableObjectAlarm(stub);
		} finally {
			vi.useRealTimers();
		}

		const event = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(event.status).toBe(404);
		const listAfter = await listAttachments(testUser.token!, project.slug, eventId);
		expect(listAfter.status).toBe(404);
		const download = await downloadAttachment(testUser.token!, project.slug, attachmentId);
		expect(download.status).toBe(404);
	});

	it('single issue delete cascade', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Del One ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'delete me via issue')),
				...attachmentItem('del.txt', 'deleted with issue'),
			]),
		);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		const attachmentId = list.attachments[0].id;

		const issues = await getIssues(testUser.token!, project.slug);
		const del = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/issues/${issues[0].id}`,
			{ method: 'DELETE' },
		);
		expect(del.status).toBe(200);

		const download = await downloadAttachment(testUser.token!, project.slug, attachmentId);
		expect(download.status).toBe(404);
		const listAfter = await listAttachments(testUser.token!, project.slug, eventId);
		expect(listAfter.status).toBe(404);
	});

	it('bulk delete cascade', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Del Bulk ${Date.now()}`,
		});
		const attachmentIds: string[] = [];
		for (const message of ['bulk a', 'bulk b']) {
			const eventId = crypto.randomUUID().replace(/-/g, '');
			await postEnvelope(
				project,
				envelopeBytes([
					envelopeHeader(project, eventId),
					'\n',
					...eventItem(baseEvent(eventId, message)),
					...attachmentItem(`${message.replace(' ', '-')}.txt`, message),
				]),
			);
			const list = await listAttachments(testUser.token!, project.slug, eventId);
			attachmentIds.push(list.attachments[0].id);
		}
		const issues = await getIssues(testUser.token!, project.slug);
		expect(issues).toHaveLength(2);

		const bulk = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/issues/bulk`,
			{
				method: 'PATCH',
				body: JSON.stringify({ issueIds: issues.map((i) => i.id), action: 'delete' }),
			},
		);
		expect(bulk.status).toBe(200);

		for (const id of attachmentIds) {
			const download = await downloadAttachment(testUser.token!, project.slug, id);
			expect(download.status).toBe(404);
		}
	});

	it('merge preserves downloadable bytes under the surviving issue', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Merge ${Date.now()}`,
		});
		const eventIdA = crypto.randomUUID().replace(/-/g, '');
		const eventIdB = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventIdA),
				'\n',
				...eventItem({
					...baseEvent(eventIdA, 'primary'),
					exception: { values: [{ type: 'MergePrimaryError', value: 'primary' }] },
				}),
				...attachmentItem('primary.txt', 'primary bytes'),
			]),
		);
		await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventIdB),
				'\n',
				...eventItem({
					...baseEvent(eventIdB, 'secondary'),
					exception: { values: [{ type: 'MergeSecondaryError', value: 'secondary' }] },
				}),
				...attachmentItem('secondary.txt', 'secondary bytes'),
			]),
		);
		const issues = await getIssues(testUser.token!, project.slug);
		expect(issues).toHaveLength(2);
		const primary = issues[0];
		const secondary = issues[1];

		const merge = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/issues/merge`,
			{
				method: 'POST',
				body: JSON.stringify({
					primaryIssueId: primary.id,
					issueIds: [primary.id, secondary.id],
				}),
			},
		);
		expect(merge.status).toBe(200);

		// Both events now live under the surviving issue, attachments included
		const listA = await listAttachments(testUser.token!, project.slug, eventIdA);
		const listB = await listAttachments(testUser.token!, project.slug, eventIdB);
		expect(listA.issueId).toBe(primary!.id);
		expect(listB.issueId).toBe(primary!.id);
		const downloadA = await downloadAttachment(
			testUser.token!,
			project.slug,
			listA.attachments[0].id,
		);
		const downloadB = await downloadAttachment(
			testUser.token!,
			project.slug,
			listB.attachments[0].id,
		);
		expect(new TextDecoder().decode(downloadA.bytes!)).toBe('primary bytes');
		expect(new TextDecoder().decode(downloadB.bytes!)).toBe('secondary bytes');
	});

	it('purge removes attachments', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Purge ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'purge me')),
				...attachmentItem('purge.txt', 'purged'),
			]),
		);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		const attachmentId = list.attachments[0].id;

		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const purged = await stub.fetch('http://internal/purge');
		expect(purged.status).toBe(200);

		const download = await downloadAttachment(testUser.token!, project.slug, attachmentId);
		expect(download.status).toBe(404);
	});

	it('quota reclamation: deletion frees byte+row budget', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Reclaim ${Date.now()}`,
		});
		await setProjectConfig(testUser.token!, project.slug, {
			maxAttachmentBytes: 10,
			maxAttachmentRows: 1,
		});

		const firstId = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, firstId),
				'\n',
				...eventItem(baseEvent(firstId, 'reclaim first')),
				...attachmentItem('ten.txt', '0123456789'), // byte budget exactly full
			]),
		);

		// Both budgets are exhausted for new attachments
		const blockedId = crypto.randomUUID().replace(/-/g, '');
		const blocked = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, blockedId),
				'\n',
				...eventItem(baseEvent(blockedId, 'reclaim blocked')),
				...attachmentItem('blocked.txt', ''),
			]),
		);
		expect(blocked.data.droppedAttachments).toEqual([
			{ filename: 'blocked.txt', reason: 'project_attachment_count' },
		]);

		// Deleting the issue that owns the stored attachment reclaims row and
		// byte budget (the two events fingerprint to separate issues)
		const firstEvent = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${firstId}`,
		);
		const firstIssueId = ((await firstEvent.json()) as { issueId: string }).issueId;
		const del = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/issues/${firstIssueId}`,
			{ method: 'DELETE' },
		);
		expect(del.status).toBe(200);

		const afterId = crypto.randomUUID().replace(/-/g, '');
		const after = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, afterId),
				'\n',
				...eventItem(baseEvent(afterId, 'reclaim after')),
				...attachmentItem('reclaimed.txt', '0123456789'),
			]),
		);
		expect(after.data.droppedAttachments).toEqual([]);
		const list = await listAttachments(testUser.token!, project.slug, afterId);
		expect(list.attachments).toHaveLength(1);
	});

	it('injected write failure rolls back the whole event', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Rollback ${Date.now()}`,
		});
		// maxEventsPerHour=1: if the failed ingest consumed quota, the clean
		// retry would 429.
		await setProjectConfig(testUser.token!, project.slug, { maxEventsPerHour: 1 });

		const eventId = crypto.randomUUID().replace(/-/g, '');
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));

		// A filename over 200 chars violates the attachments CHECK constraint.
		// The narrow ON CONFLICT(id) clause does not absorb CHECK failures, so
		// the violation reaches SQL and rolls back the whole transaction.
		const failing = await stub.fetch('http://internal/ingest-with-attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event: baseEvent(eventId, 'rollback probe'),
				attachments: [
					{
						filename: 'x'.repeat(201),
						contentType: 'text/plain',
						data: 'never stored',
						size: 11,
					},
				],
			}),
		});
		expect(failing.status).toBe(500);

		// No partial state: no event, no issue, no tags/stats side effects
		const event = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(event.status).toBe(404);
		expect(await getIssues(testUser.token!, project.slug)).toHaveLength(0);

		// Quota was not consumed by the failed ingest
		const rate = await authFetch(
			testUser.token!,
			`http://localhost/api/projects/${project.slug}/rate-limit`,
		);
		const rateData = (await rate.json()) as { currentHourCount: number };
		expect(rateData.currentHourCount).toBe(0);

		// A clean retry with the same event id succeeds and stores everything
		const retry = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'rollback probe')),
				...attachmentItem('clean.txt', 'clean retry'),
			]),
		);
		expect(retry.status).toBe(200);
		expect(retry.data.id).toBe(eventId);
		expect(retry.data.droppedAttachments).toEqual([]);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.attachments).toHaveLength(1);

		// The committed retry did consume the one-event quota
		const extraId = crypto.randomUUID().replace(/-/g, '');
		const extra = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, extraId),
				'\n',
				...eventItem(baseEvent(extraId, 'should be rate limited')),
			]),
		);
		expect(extra.status).toBe(429);
	});

	it('fetch auth matrix: anonymous, DSN-only, non-member, cross-project × list+download rejected', async () => {
		const owner = testUser;
		const outsider = await createTestUser({
			email: `outsider-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Outsider',
		});
		const projectA = await createTestProject(owner.token!, {
			name: `AuthA ${Date.now()}`,
		});
		const projectB = await createTestProject(outsider.token!, {
			name: `AuthB ${Date.now()}`,
		});

		const eventId = crypto.randomUUID().replace(/-/g, '');
		await postEnvelope(
			projectA,
			envelopeBytes([
				envelopeHeader(projectA, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'auth matrix')),
				...attachmentItem('secret.txt', 'member-only bytes'),
			]),
		);
		const list = await listAttachments(owner.token!, projectA.slug, eventId);
		const attachmentId = list.attachments[0].id;
		const listUrl = `/api/projects/${projectA.slug}/events/${eventId}/attachments`;
		const downloadUrl = `/api/projects/${projectA.slug}/attachments/${attachmentId}`;

		// Anonymous
		for (const url of [listUrl, downloadUrl]) {
			const response = await SELF.fetch(`http://localhost${url}`);
			expect(response.status).toBe(401);
		}

		// DSN public key as a bearer token: ingestion credentials never grant
		// read access
		for (const url of [listUrl, downloadUrl]) {
			const response = await SELF.fetch(`http://localhost${url}`, {
				headers: { Authorization: `Bearer ${projectA.publicKey}` },
			});
			expect(response.status).toBe(401);
		}

		// Non-member of project A: no metadata, no bytes
		for (const url of [listUrl, downloadUrl]) {
			const response = await authFetch(outsider.token!, `http://localhost${url}`);
			expect(response.status).toBe(404);
			const body = (await response.json()) as { attachments?: unknown };
			expect(body.attachments).toBeUndefined();
		}

		// Cross-project: A's ids looked up under B (where the outsider IS a
		// member) resolve to nothing — attachment rows live in the project's
		// own Durable Object
		const crossList = await authFetch(
			outsider.token!,
			`http://localhost/api/projects/${projectB.slug}/events/${eventId}/attachments`,
		);
		expect(crossList.status).toBe(404);
		const crossDownload = await authFetch(
			outsider.token!,
			`http://localhost/api/projects/${projectB.slug}/attachments/${attachmentId}`,
		);
		expect(crossDownload.status).toBe(404);
	});

	it('header hardening: CRLF, quotes/backslashes, Unicode filename, malformed content type', async () => {
		const project = await createTestProject(testUser.token!, {
			name: `Headers ${Date.now()}`,
		});
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const result = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, eventId),
				'\n',
				...eventItem(baseEvent(eventId, 'header hardening')),
				...attachmentItem('evil\r\nSet-Cookie: pwned.txt', 'crlf'),
				...attachmentItem('quo"te\\d.txt', 'quotes'),
				...attachmentItem('logs-日本語.txt', 'unicode'),
				...attachmentItem('badct.txt', 'bad', 'text/plain; charset="utf-8'),
				...attachmentItem('good.txt', 'plain', 'text/csv'),
			]),
		);
		expect(result.status).toBe(200);
		const list = await listAttachments(testUser.token!, project.slug, eventId);
		expect(list.attachments).toHaveLength(5);

		const crlf = await downloadAttachment(testUser.token!, project.slug, list.attachments[0].id);
		const disposition = crlf.headers.get('Content-Disposition') ?? '';
		expect(disposition).toMatch(/^attachment; filename="/);
		// CR/LF are the header-injection vector: none may survive anywhere in
		// the value (the RFC 5987 extension only carries them percent-encoded)
		expect(disposition).not.toContain('\n');
		expect(disposition).not.toContain('\r');
		expect(disposition).not.toContain('%0D');
		expect(disposition).not.toContain('%0A');
		// The quoted fallback cannot contain quotes or backslashes
		const fallback = disposition.match(/filename="([^"]*)"/)?.[1] ?? '';
		expect(fallback).not.toMatch(/["\\]/);

		const quoted = await downloadAttachment(testUser.token!, project.slug, list.attachments[1].id);
		const quotedDisposition = quoted.headers.get('Content-Disposition') ?? '';
		expect(quotedDisposition).toBe('attachment; filename="quoted.txt"');

		const unicode = await downloadAttachment(testUser.token!, project.slug, list.attachments[2].id);
		const unicodeDisposition = unicode.headers.get('Content-Disposition') ?? '';
		expect(unicodeDisposition).toContain("filename*=UTF-8''");
		expect(unicodeDisposition).toContain(encodeURIComponent('logs-日本語.txt'));
		// The quoted fallback must be ASCII-only (the non-ASCII name is
		// carried by the filename* extension, not the fallback)
		const unicodeFallback = unicodeDisposition.match(/filename="([^"]*)"/)?.[1] ?? '';
		expect(unicodeFallback).toMatch(/^[\x20-\x7e]*$/);
		expect(unicodeFallback).not.toContain('日');

		// A filename truncated mid-astral-pair at ingest keeps a well-formed
		// stored name, so download header encoding never throws
		const astralId = crypto.randomUUID().replace(/-/g, '');
		const astralName = `${'a'.repeat(199)}😀`;
		const astral = await postEnvelope(
			project,
			envelopeBytes([
				envelopeHeader(project, astralId),
				'\n',
				...eventItem(baseEvent(astralId, 'astral filename truncation')),
				...attachmentItem(astralName, 'astral'),
			]),
		);
		expect(astral.status).toBe(200);
		const astralList = await listAttachments(testUser.token!, project.slug, astralId);
		expect(astralList.attachments).toHaveLength(1);
		expect(astralList.attachments[0].filename.length).toBeLessThanOrEqual(200);
		const astralDownload = await downloadAttachment(
			testUser.token!,
			project.slug,
			astralList.attachments[0].id,
		);
		expect(astralDownload.status).toBe(200);
		expect(astralDownload.headers.get('Content-Disposition')).toMatch(/^attachment; /);

		const badct = await downloadAttachment(testUser.token!, project.slug, list.attachments[3].id);
		expect(badct.headers.get('Content-Type')).toBe('application/octet-stream');

		// Structurally valid content types pass through unchanged
		const good = await downloadAttachment(testUser.token!, project.slug, list.attachments[4].id);
		expect(good.headers.get('Content-Type')).toBe('text/csv');
	});
});
