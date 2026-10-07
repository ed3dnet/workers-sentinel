import { SELF } from 'cloudflare:test';
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

	it('does not grant wildcard CORS on protected feedback reads', async () => {
		const response = await SELF.fetch('http://localhost/api/projects/not-a-project/feedback', {
			headers: { Origin: 'https://arbitrary.example' },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
	});
});
