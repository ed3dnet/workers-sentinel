import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

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

		// Delete
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
});
