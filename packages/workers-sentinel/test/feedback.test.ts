import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTestEnvelope, createTestProject, createTestUser, sendTestEvent } from './utils';

function metadata(overrides: Record<string, unknown> = {}) {
	return {
		description: 'Button does not work',
		pageUrl: 'https://customer.example/help',
		pageTitle: 'Help',
		locator: 'button#submit',
		geometry: { x: 1, y: 2, width: 30, height: 20 },
		metadata: { version: '1.2' },
		...overrides,
	};
}

function png() {
	const bytes = new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
		0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1,
		0, 201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
	]);
	return new Blob([bytes], { type: 'image/png' });
}

async function submit(
	projectId: string,
	publicKey: string,
	payload = metadata(),
	screenshot?: Blob,
	origin = 'https://arbitrary.example',
) {
	const form = new FormData();
	form.set('metadata', JSON.stringify(payload));
	if (screenshot) form.set('screenshot', screenshot, 'image.png');
	return SELF.fetch(`http://localhost/api/${projectId}/feedback?sentry_key=${publicKey}`, {
		method: 'POST',
		headers: { Origin: origin },
		body: form,
	});
}

describe('website feedback API', () => {
	it('accepts valid public submissions and lists details only for project members', async () => {
		const user = await createTestUser({
			email: `feedback-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback User',
		});
		const project = await createTestProject(user.token!, { name: 'Feedback project' });
		const accepted = await submit(project.id, project.publicKey, metadata(), png());
		expect(accepted.status).toBe(201);
		expect(accepted.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(accepted.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		const acceptedBody = (await accepted.json()) as { success: boolean; id: string };
		expect(acceptedBody.success).toBe(true);
		expect(Object.keys(acceptedBody).sort()).toEqual(['id', 'success']);

		const screenshotResponse = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback/${acceptedBody.id}/screenshot`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(screenshotResponse.status).toBe(200);
		expect(screenshotResponse.headers.get('Content-Type')).toBe('image/png');
		expect(screenshotResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
		const screenshotBytes = Array.from(new Uint8Array(await screenshotResponse.arrayBuffer()));
		const updateFeedback = (status: 'resolved' | 'unresolved') =>
			SELF.fetch(`http://localhost/api/projects/${project.slug}/feedback/${acceptedBody.id}`, {
				method: 'PATCH',
				headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ status }),
			});
		for (const status of ['resolved', 'unresolved'] as const) {
			const updated = await updateFeedback(status);
			expect(updated.status).toBe(200);
			expect(((await updated.json()) as { feedback: { status: string } }).feedback.status).toBe(
				status,
			);
			const screenshotAfterStatus = await SELF.fetch(
				`http://localhost/api/projects/${project.slug}/feedback/${acceptedBody.id}/screenshot`,
				{ headers: { Authorization: `Bearer ${user.token}` } },
			);
			expect(Array.from(new Uint8Array(await screenshotAfterStatus.arrayBuffer()))).toEqual(
				screenshotBytes,
			);
		}

		for (const origin of ['https://arbitrary.example', 'https://listed.example']) {
			const preflight = await SELF.fetch(`http://localhost/api/${project.id}/feedback`, {
				method: 'OPTIONS',
				headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull();
			const post = await submit(project.id, project.publicKey, metadata(), undefined, origin);
			expect(post.status).toBe(201);
			expect(post.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(post.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		}

		const list = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?limit=1`,
			{
				headers: { Authorization: `Bearer ${user.token}` },
			},
		);
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({
			feedback: [
				{
					description: 'Button does not work',
					pageUrl: 'https://customer.example/help',
					screenshotType: null,
				},
			],
		});
	});

	it('rejects invalid keys, malformed metadata, and image signature/type mismatches', async () => {
		const user = await createTestUser({
			email: `feedback-invalid-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback User',
		});
		const project = await createTestProject(user.token!, { name: 'Invalid feedback project' });
		expect((await submit(project.id, 'wrong-key')).status).toBe(401);
		expect(
			(await submit(project.id, project.publicKey, metadata({ description: '' }))).status,
		).toBe(400);
		const mismatch = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/png' });
		expect((await submit(project.id, project.publicKey, metadata(), mismatch)).status).toBe(400);
		const extraField = new FormData();
		extraField.set('metadata', JSON.stringify(metadata()));
		extraField.set('unexpected', 'ignored fields are not accepted');
		const extraResponse = await SELF.fetch(
			`http://localhost/api/${project.id}/feedback?sentry_key=${project.publicKey}`,
			{ method: 'POST', body: extraField },
		);
		expect(extraResponse.status).toBe(400);
	});

	it('uses a separate hourly feedback quota from the error-event quota', async () => {
		const user = await createTestUser({
			email: `feedback-quota-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback Quota User',
		});
		const project = await createTestProject(user.token!, { name: 'Feedback quota project' });
		const configure = await SELF.fetch(`http://localhost/api/projects/${project.slug}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ maxEventsPerHour: 1 }),
		});
		expect(configure.ok).toBe(true);

		expect((await submit(project.id, project.publicKey)).status).toBe(201);
		expect((await sendTestEvent(project.id, project.publicKey)).id).toBeTruthy();
		const eventResponse = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: createTestEnvelope(project.id, project.publicKey),
		});
		expect(eventResponse.status).toBe(429);
		expect(
			(
				await submit(
					project.id,
					project.publicKey,
					metadata({ description: 'Still under feedback limit' }),
				)
			).status,
		).toBe(201);
	});

	it('migrates a pre-status feedback table with existing rows as unresolved', async () => {
		const id = `legacy-${crypto.randomUUID()}`;
		const stub = env.PROJECT_STATE.get(
			env.PROJECT_STATE.idFromName(`legacy-feedback-${crypto.randomUUID()}`),
		);
		const fixture = await stub.fetch(
			new Request('http://internal/test/legacy-feedback-fixture', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id }),
			}),
		);
		expect(fixture.status).toBe(200);
		const migrated = await stub.fetch(
			new Request('http://internal/feedback/detail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id }),
			}),
		);
		expect(((await migrated.json()) as { feedback: { status: string } }).feedback.status).toBe(
			'unresolved',
		);
		const migrationList = await stub.fetch(
			new Request('http://internal/feedback/list', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'unresolved', query: 'Legacy feedback', limit: 10 }),
			}),
		);
		const migratedRows = (
			(await migrationList.json()) as { feedback: Array<{ id: string; status: string }> }
		).feedback;
		expect(migratedRows).toEqual([expect.objectContaining({ id, status: 'unresolved' })]);
		const migrationResolve = await stub.fetch(
			new Request('http://internal/feedback/status', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, status: 'resolved' }),
			}),
		);
		expect(
			((await migrationResolve.json()) as { feedback: { status: string } }).feedback.status,
		).toBe('resolved');
	});

	it('filters feedback by status and bounded text before stable cursor paging; status updates persist', async () => {
		const user = await createTestUser({
			email: `feedback-filter-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback Filter User',
		});
		const project = await createTestProject(user.token!, {
			name: `Feedback filters ${crypto.randomUUID()}`,
		});
		const ids: string[] = [];
		for (const description of [
			'match alpha',
			'match beta',
			'other report',
			'wild%card',
			'wildXcard',
			'under_score',
			'underXscore',
		]) {
			const response = await submit(project.id, project.publicKey, metadata({ description }));
			expect(response.status).toBe(201);
			ids.push(((await response.json()) as { id: string }).id);
		}
		const update = (feedbackId: string, status: string) =>
			SELF.fetch(`http://localhost/api/projects/${project.slug}/feedback/${feedbackId}`, {
				method: 'PATCH',
				headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ status }),
			});
		const resolve = await update(ids[1], 'resolved');
		expect(resolve.status).toBe(200);
		expect(((await resolve.json()) as { feedback: { status: string } }).feedback.status).toBe(
			'resolved',
		);
		const filteredUrl = `http://localhost/api/projects/${project.slug}/feedback?status=unresolved&query=match&limit=1`;
		const first = await SELF.fetch(filteredUrl, {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		const page = (await first.json()) as {
			feedback: Array<{ id: string; status: string }>;
			nextCursor: string;
			hasMore: boolean;
		};
		expect(page.feedback).toHaveLength(1);
		expect(page.feedback[0].status).toBe('unresolved');
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeUndefined();
		const fullListing = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?limit=100`,
			{
				headers: { Authorization: `Bearer ${user.token}` },
			},
		);
		const orderedIds = (
			(await fullListing.json()) as { feedback: Array<{ id: string; receivedAt: string }> }
		).feedback.map((item) => item.id);
		const pagedIds: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const pageUrl = new URL(`http://localhost/api/projects/${project.slug}/feedback`);
			pageUrl.searchParams.set('limit', '1');
			if (cursor) pageUrl.searchParams.set('cursor', cursor);
			const response = await SELF.fetch(pageUrl, {
				headers: { Authorization: `Bearer ${user.token}` },
			});
			const current = (await response.json()) as {
				feedback: Array<{ id: string }>;
				nextCursor?: string;
				hasMore: boolean;
			};
			pagedIds.push(...current.feedback.map((item) => item.id));
			if (!current.hasMore) {
				expect(current.nextCursor).toBeUndefined();
				break;
			}
			expect(current.nextCursor).toBeTruthy();
			cursor = current.nextCursor;
		}
		expect(pagedIds).toEqual(orderedIds);
		const allStatus = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?query=match&limit=1`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		const allPage = (await allStatus.json()) as {
			feedback: Array<{ id: string; status: string }>;
			nextCursor?: string;
			hasMore: boolean;
		};
		expect(allPage.feedback).toHaveLength(1);
		expect(allPage.hasMore).toBe(true);
		expect(allPage.nextCursor).toBeTruthy();
		const next = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?query=match&limit=1&cursor=${encodeURIComponent(allPage.nextCursor!)}`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		const nextPage = (await next.json()) as { feedback: Array<{ id: string; status: string }> };
		expect(nextPage.feedback).toHaveLength(1);
		expect(nextPage.feedback[0].id).not.toBe(allPage.feedback[0].id);
		expect(['unresolved', 'resolved']).toContain(nextPage.feedback[0].status);
		const combinedFilter = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?status=resolved&query=match`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(
			((await combinedFilter.json()) as { feedback: Array<{ id: string; status: string }> })
				.feedback,
		).toEqual([expect.objectContaining({ id: ids[1], status: 'resolved' })]);
		expect((await update(ids[1], 'unresolved')).status).toBe(200);
		const literalPercent = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?query=${encodeURIComponent('%')}`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(
			((await literalPercent.json()) as { feedback: Array<{ id: string }> }).feedback.map(
				(item) => item.id,
			),
		).toEqual([ids[3]]);
		const literalUnderscore = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?query=${encodeURIComponent('_')}`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(
			((await literalUnderscore.json()) as { feedback: Array<{ id: string }> }).feedback.map(
				(item) => item.id,
			),
		).toEqual([ids[5]]);
		for (const body of [{ status: 'ignored' }, { status: 'resolved', unexpected: true }]) {
			const invalid = await SELF.fetch(
				`http://localhost/api/projects/${project.slug}/feedback/${ids[0]}`,
				{
					method: 'PATCH',
					headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			);
			expect(invalid.status).toBe(400);
		}
		const missing = await update('missing-feedback-id', 'resolved');
		expect(missing.status).toBe(404);
		const tooLong = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/feedback?query=${'x'.repeat(201)}`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(tooLong.status).toBe(400);
	});

	it('hides foreign-project feedback details and refuses cross-project status updates', async () => {
		const owner = await createTestUser({
			email: `feedback-owner-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback Owner',
		});
		const outsider = await createTestUser({
			email: `feedback-outsider-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Feedback Outsider',
		});
		const ownerProject = await createTestProject(owner.token!, {
			name: `Private feedback ${crypto.randomUUID()}`,
		});
		const outsiderProject = await createTestProject(outsider.token!, {
			name: `Other project ${crypto.randomUUID()}`,
		});
		const accepted = await submit(
			ownerProject.id,
			ownerProject.publicKey,
			metadata({ description: 'private report' }),
		);
		const feedbackId = ((await accepted.json()) as { id: string }).id;
		const detail = await SELF.fetch(
			`http://localhost/api/projects/${ownerProject.slug}/feedback/${feedbackId}`,
			{ headers: { Authorization: `Bearer ${outsider.token}` } },
		);
		expect(detail.status).toBe(404);
		const update = await SELF.fetch(
			`http://localhost/api/projects/${outsiderProject.slug}/feedback/${feedbackId}`,
			{
				method: 'PATCH',
				headers: { Authorization: `Bearer ${outsider.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'resolved' }),
			},
		);
		expect(update.status).toBe(404);
		const ownerDetail = await SELF.fetch(
			`http://localhost/api/projects/${ownerProject.slug}/feedback/${feedbackId}`,
			{ headers: { Authorization: `Bearer ${owner.token}` } },
		);
		expect(((await ownerDetail.json()) as { feedback: { status: string } }).feedback.status).toBe(
			'unresolved',
		);
	});

	it('does not grant wildcard CORS on protected feedback reads', async () => {
		const response = await SELF.fetch('http://localhost/api/projects/not-a-project/feedback', {
			headers: { Origin: 'https://arbitrary.example' },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
	});
});
