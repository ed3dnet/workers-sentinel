import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { adminFetch, authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

const BASE = 'http://localhost';

describe('project deletion purges ProjectState', () => {
	it('removes all event data when the project is deleted', async () => {
		const user = await createTestUser({
			email: `purge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Purge User',
		});
		const project = await createTestProject(user.token!, {
			name: `Purge ${Date.now()}`,
			platform: 'javascript',
		});

		await sendTestEvent(project.id, project.publicKey, {
			exception: { type: 'Error', value: 'purge me' },
		});

		// Issue exists before deletion
		const issuesBefore = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const beforeData = (await issuesBefore.json()) as { issues?: unknown[] };
		const beforeList = beforeData.issues ?? (beforeData as unknown as unknown[]);
		expect(beforeList.length).toBeGreaterThan(0);

		// Delete (retained owner-delete path)
		const del = await authFetch(user.token!, `http://localhost/api/projects/${project.slug}`, {
			method: 'DELETE',
		});
		expect(del.status).toBeLessThan(300);

		// The ProjectState DO itself must now be empty. deleteAll() removes the
		// schema too, so the DO either errors ('no such table') or reports no
		// issues — both prove the tenant data is gone.
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const issues = await stub.fetch(
			new Request('http://internal/issues', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		if (issues.ok) {
			const data = (await issues.json()) as { issues?: unknown[] };
			const list = data.issues ?? (data as unknown as unknown[]);
			expect(list.length).toBe(0);
		} else {
			const errorText = await issues.text();
			expect(errorText).toContain('no such table');
		}
	});

	it('admin deletion (non-owner) purges ProjectState too', async () => {
		const user = await createTestUser({
			email: `purge-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Purge Admin User',
		});
		const project = await createTestProject(user.token!, {
			name: `Purge Admin ${Date.now()}`,
			platform: 'javascript',
		});

		await sendTestEvent(project.id, project.publicKey, {
			exception: { type: 'Error', value: 'admin purge me' },
		});

		const del = await adminFetch(`${BASE}/api/admin/projects/${project.id}`, {
			method: 'DELETE',
		});
		expect(del.status).toBeLessThan(300);

		// Ingestion to the deleted project fails: the Sentry-compat surface
		// answers 401 invalid_auth for unknown DSN keys
		const ingestAfter = await authFetch(user.token!, `${BASE}/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: JSON.stringify({
				event_id: crypto.randomUUID().replace(/-/g, ''),
				dsn: `https://${project.publicKey}@localhost/${project.id}`,
			})
				.concat('\n')
				.concat(JSON.stringify({ type: 'event' }))
				.concat('\n')
				.concat(
					JSON.stringify({
						event_id: crypto.randomUUID().replace(/-/g, ''),
						timestamp: new Date().toISOString(),
						platform: 'javascript',
					}),
				),
		});
		expect(ingestAfter.status).toBe(401);

		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const issues = await stub.fetch(
			new Request('http://internal/issues', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		if (issues.ok) {
			const data = (await issues.json()) as { issues?: unknown[] };
			const list = data.issues ?? (data as unknown as unknown[]);
			expect(list.length).toBe(0);
		} else {
			const errorText = await issues.text();
			expect(errorText).toContain('no such table');
		}
	});
});
