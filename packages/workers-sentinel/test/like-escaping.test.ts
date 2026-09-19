import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

describe('issue search LIKE escaping', () => {
	it('treats % and _ as literals in search queries', async () => {
		const user = await createTestUser({
			email: `like-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Like User',
		});
		const project = await createTestProject(user.token!, { name: `Like ${Date.now()}` });

		await sendTestEvent(project.id, project.publicKey, {
			exception: { type: 'Error', value: 'definitely unique marker' },
		});
		await sendTestEvent(project.id, project.publicKey, {
			exception: { type: 'Error', value: 'another different marker' },
		});

		// A pure-wildcard query must not match everything
		const wildcard = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues?query=${encodeURIComponent('%')}`,
		);
		expect(wildcard.ok).toBe(true);
		const wildcardData = (await wildcard.json()) as { issues?: unknown[] };
		const wildcardList = wildcardData.issues ?? (wildcardData as unknown as unknown[]);
		expect(wildcardList.length).toBe(0);

		// A literal substring still matches
		const literal = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues?query=${encodeURIComponent('unique marker')}`,
		);
		expect(literal.ok).toBe(true);
		const literalData = (await literal.json()) as { issues?: unknown[] };
		const literalList = literalData.issues ?? (literalData as unknown as unknown[]);
		expect(literalList.length).toBe(1);
	});
});
