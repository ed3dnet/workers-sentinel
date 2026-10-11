import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestProject, createTestUser, sendTestEvent } from './utils';

let user: Awaited<ReturnType<typeof createTestUser>>;
const metadata = {
	description: 'Lifecycle report',
	pageUrl: 'https://customer.example/page',
	pageTitle: 'Page',
	locator: '#target',
	geometry: { x: 10, y: 20, width: 40, height: 50 },
	metadata: { release: 'test' },
};
const pngBytes = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
	),
	(ch) => ch.charCodeAt(0),
);
function stub(id: string) {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(id));
}
async function internal(id: string, route: string, data: unknown = {}) {
	return stub(id).fetch(
		new Request(`http://internal${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		}),
	);
}
async function project() {
	return createTestProject(user.token!, { name: `Feedback lifecycle ${crypto.randomUUID()}` });
}
async function submit(
	p: Awaited<ReturnType<typeof project>>,
	image: Blob | undefined = new Blob([pngBytes], { type: 'image/png' }),
	fault?: string,
) {
	const form = new FormData();
	form.set('metadata', JSON.stringify(metadata));
	if (image) form.set('screenshot', image, 'untrusted-user-filename.png');
	return SELF.fetch(`http://localhost/api/${p.id}/feedback?sentry_key=${p.publicKey}`, {
		method: 'POST',
		body: form,
		headers: fault ? { 'X-Sentinel-Test-Fault': fault } : {},
	});
}
async function keys(id: string) {
	return (await env.ATTACHMENTS.list({ prefix: `p/${id}/` })).objects.map((item) => item.key);
}
async function detail(p: Awaited<ReturnType<typeof project>>, id: string, token = user.token) {
	return SELF.fetch(`http://localhost/api/projects/${p.slug}/feedback/${id}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

beforeAll(async () => {
	user = await createTestUser({
		email: `feedback-life-${crypto.randomUUID()}@example.com`,
		password: 'testpassword123',
		name: 'Feedback lifecycle',
	});
});
describe('feedback storage lifecycle', () => {
	it('accepts each raster signature and rejects unsafe, unknown, and mismatched MIME content', async () => {
		const p = await project();
		for (const [type, data] of [
			['image/png', pngBytes],
			['image/jpeg', new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217])],
			['image/webp', new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])],
		] as const) {
			const response = await submit(p, new Blob([data], { type }));
			expect(response.status).toBe(201);
			const { id } = (await response.json()) as { id: string };
			const download = await SELF.fetch(
				`http://localhost/api/projects/${p.slug}/feedback/${id}/screenshot`,
				{ headers: { Authorization: `Bearer ${user.token}` } },
			);
			expect(download.status).toBe(200);
			expect(download.headers.get('Content-Type')).toBe(type);
			expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
		}
		for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', 'image/jpeg']) {
			expect((await submit(p, new Blob([pngBytes], { type }))).status).toBe(400);
		}
	});

	it('has member-only detail and download with stable keyset pages and project isolation', async () => {
		const p = await project();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const response = await submit(p);
			ids.push(((await response.json()) as { id: string }).id);
		}
		const list = (cursor = '') =>
			SELF.fetch(
				`http://localhost/api/projects/${p.slug}/feedback?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
				{ headers: { Authorization: `Bearer ${user.token}` } },
			);
		const first = (await (await list()).json()) as {
			feedback: Array<{ id: string }>;
			nextCursor: string;
			hasMore: boolean;
		};
		expect(first.feedback).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		const second = (await (await list(first.nextCursor)).json()) as {
			feedback: Array<{ id: string }>;
			nextCursor?: string;
			hasMore: boolean;
		};
		expect(second.feedback).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeUndefined();
		expect(new Set([...first.feedback, ...second.feedback].map((r) => r.id)).size).toBe(3);
		const other = await project();
		expect((await detail(other, ids[0])).status).toBe(404);
		const outsider = await createTestUser({
			email: `feedback-outsider-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Outsider',
		});
		expect((await detail(p, ids[0], outsider.token)).status).toBe(404);
		for (const suffix of ['', '/screenshot']) {
			expect(
				(await SELF.fetch(`http://localhost/api/projects/${p.slug}/feedback/${ids[0]}${suffix}`))
					.status,
			).toBe(401);
			expect(
				(
					await SELF.fetch(
						`http://localhost/api/projects/${p.slug}/feedback/${ids[0]}${suffix}?sentry_key=${p.publicKey}`,
					)
				).status,
			).toBe(401);
		}
	});

	it('shares attachment quota, cleans removal bytes, and preserves committed references through GC', async () => {
		const p = await project();
		await internal(p.id, '/config/update', { maxAttachmentBytes: pngBytes.length });
		const response = await submit(p);
		expect(response.status).toBe(201);
		const { id } = (await response.json()) as { id: string };
		expect((await submit(p)).status).toBe(413);
		const liveKeys = await keys(p.id);
		expect(liveKeys).toHaveLength(1);
		expect(liveKeys[0]).not.toContain('untrusted-user-filename');
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
			await runDurableObjectAlarm(stub(p.id));
			expect(await keys(p.id)).toEqual(liveKeys);
		} finally {
			vi.useRealTimers();
		}
		expect((await internal(p.id, '/feedback/delete', { id })).status).toBe(200);
		expect(await keys(p.id)).toHaveLength(0);
		expect((await submit(p)).status).toBe(201);
	});

	it('initializes first-feedback GC before upload, failed commit, and failed compensating delete', async () => {
		const p = await project();
		const response = await submit(
			p,
			new Blob([pngBytes], { type: 'image/png' }),
			'feedback-commit',
		);
		expect(response.status).toBe(503);
		expect(await keys(p.id)).toHaveLength(1);
		const list = await internal(p.id, '/feedback/list');
		expect(((await list.json()) as { feedback: unknown[] }).feedback).toHaveLength(0);
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
			await runDurableObjectAlarm(stub(p.id));
			expect(await keys(p.id)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('prunes feedback and image with project retention and purges the entire prefix', async () => {
		const p = await project();
		expect((await submit(p)).status).toBe(201);
		await internal(p.id, '/settings/update', { retentionDays: 1 });
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
			await runDurableObjectAlarm(stub(p.id));
			expect(await keys(p.id)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
		expect((await submit(p)).status).toBe(201);
		await internal(p.id, '/purge', { projectId: p.id });
		expect(await keys(p.id)).toHaveLength(0);
		expect(
			(await internal(p.id, '/feedback/commit', { id: crypto.randomUUID(), ...metadata })).status,
		).toBe(503);
	});

	it('reclaims a late R2 put after purge when metadata and compensation both fail', async () => {
		const p = await project();
		await internal(p.id, '/feedback/touch', { projectId: p.id });
		const key = `p/${p.id}/feedback/paused-upload`;
		expect(
			(
				await internal(p.id, '/feedback/prepare', {
					id: 'paused',
					objectKey: key,
					screenshotSize: pngBytes.length,
				})
			).status,
		).toBe(200);
		await internal(p.id, '/purge', { projectId: p.id });
		// Resume the request's successful bucket put after the purge sweep/wipe.
		await env.ATTACHMENTS.put(key, pngBytes);
		expect(
			(
				await internal(p.id, '/feedback/commit', {
					id: 'paused',
					...metadata,
					screenshotKey: key,
					screenshotType: 'image/png',
					screenshotSize: pngBytes.length,
				})
			).status,
		).toBe(503);
		// No compensation: reproduce its failure by leaving the late put intact.
		expect(await env.ATTACHMENTS.head(key)).not.toBeNull();
		await runDurableObjectAlarm(stub(p.id));
		expect(await env.ATTACHMENTS.head(key)).toBeNull();
		expect((await internal(p.id, '/feedback/touch', { projectId: p.id })).status).toBe(503);
	});

	it('caps the raw body before parsing multipart and bounds screenshots and metadata', async () => {
		const p = await project();
		const response = await SELF.fetch(
			`http://localhost/api/${p.id}/feedback?sentry_key=${p.publicKey}`,
			{
				method: 'POST',
				body: new Uint8Array(2 * 1024 * 1024 + 1),
				headers: { 'Content-Type': 'multipart/form-data; boundary=cap-test' },
			},
		);
		expect(response.status).toBe(413);
		expect(await keys(p.id)).toHaveLength(0);
		expect(
			(await submit(p, new Blob([new Uint8Array(1536 * 1024 + 1)], { type: 'image/png' }))).status,
		).toBe(400);
		const form = new FormData();
		form.set('metadata', JSON.stringify({ ...metadata, metadata: { large: 'x'.repeat(8193) } }));
		expect(
			(
				await SELF.fetch(`http://localhost/api/${p.id}/feedback?sentry_key=${p.publicKey}`, {
					method: 'POST',
					body: form,
				})
			).status,
		).toBe(400);
	});

	it('reserves quota atomically and rejects feedback while purge retries', async () => {
		const p = await project();
		await internal(p.id, '/feedback/touch', { projectId: p.id });
		await internal(p.id, '/config/update', { maxAttachmentBytes: pngBytes.length });
		const reservations = await Promise.all(
			[0, 1].map((index) =>
				internal(p.id, '/feedback/prepare', {
					id: `reservation-${index}`,
					objectKey: `p/${p.id}/feedback/reserved-${index}`,
					screenshotSize: pngBytes.length,
				}),
			),
		);
		expect(reservations.map((response) => response.status).sort()).toEqual([200, 413]);
		await internal(p.id, '/purge', { projectId: p.id, fault: 'purge-sweep' });
		expect((await submit(p)).status).toBe(503);
		expect((await internal(p.id, '/feedback/commit', { id: 'late', ...metadata })).status).toBe(
			503,
		);
		await runDurableObjectAlarm(stub(p.id));
		expect(await keys(p.id)).toHaveLength(0);
	});

	it('enforces exactly 100 feedback submissions without consuming event quota in either direction', async () => {
		const p = await project();
		await internal(p.id, '/config/update', { maxEventsPerHour: 1 });
		await sendTestEvent(p.id, p.publicKey);
		for (let i = 0; i < 100; i++) {
			const form = new FormData();
			form.set('metadata', JSON.stringify(metadata));
			const response = await SELF.fetch(
				`http://localhost/api/${p.id}/feedback?sentry_key=${p.publicKey}`,
				{ method: 'POST', body: form },
			);
			expect(response.status).toBe(201);
		}
		const form = new FormData();
		form.set('metadata', JSON.stringify(metadata));
		expect(
			(
				await SELF.fetch(`http://localhost/api/${p.id}/feedback?sentry_key=${p.publicKey}`, {
					method: 'POST',
					body: form,
				})
			).status,
		).toBe(429);
		await internal(p.id, '/config/update', { maxEventsPerHour: 2 });
		expect((await sendTestEvent(p.id, p.publicKey)).id).toBeTruthy();
	}, 60000);
});
