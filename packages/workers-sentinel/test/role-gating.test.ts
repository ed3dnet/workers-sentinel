import { beforeEach, describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, type TestProject } from './utils';

describe('security config role gating', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;

	beforeEach(async () => {
		owner = await createTestUser({
			email: `owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Owner User',
		});
		member = await createTestUser({
			email: `member-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Member User',
		});
		project = await createTestProject(owner.token!, {
			name: `RoleGate ${Date.now()}`,
			platform: 'javascript',
		});

		// Add the second user as a plain member
		const add = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/members`,
			{
				method: 'POST',
				body: JSON.stringify({ email: member.email, role: 'member' }),
			},
		);
		expect(add.status).toBeLessThan(300);
	});

	it('rejects retention/rate-limit changes from plain members', async () => {
		const response = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ retentionDays: 1 }),
			},
		);
		expect(response.status).toBe(403);

		const response2 = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ maxEventsPerHour: 10 }),
			},
		);
		expect(response2.status).toBe(403);
	});

	it('allows retention/rate-limit changes from the owner', async () => {
		const response = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ retentionDays: 365, maxEventsPerHour: 5000 }),
			},
		);
		expect(response.status).toBeLessThan(300);
	});

	it('rejects filter writes from plain members', async () => {
		const create = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}/filters`,
			{
				method: 'POST',
				body: JSON.stringify({ filterType: 'message', pattern: 'noise' }),
			},
		);
		expect(create.status).toBe(403);
	});

	it('allows filter management from the owner', async () => {
		const create = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/filters`,
			{
				method: 'POST',
				body: JSON.stringify({ filterType: 'message', pattern: 'noise' }),
			},
		);
		expect(create.status).toBeLessThan(300);
	});
});
