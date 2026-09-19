import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

describe('pagination bounds', () => {
	it(
		'negative limit falls back to the default page size instead of unlimited',
		{ timeout: 30000 },
		async () => {
			const user = await createTestUser({
				email: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
				password: 'testpassword123',
				name: 'Page User',
			});
			const project = await createTestProject(user.token!, {
				name: `Paging ${Date.now()}`,
				platform: 'javascript',
			});

			// 30 events on the same issue
			for (let i = 0; i < 30; i++) {
				await sendTestEvent(project.id, project.publicKey, {
					exception: { type: 'Error', value: 'pagination probe' },
				});
			}

			const negative = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/events/latest?limit=-1`,
			);
			if (!negative.ok) throw new Error(`latest events failed: ${await negative.text()}`);
			expect(negative.ok).toBe(true);
			const negativeData = (await negative.json()) as { events?: unknown[] };
			const negativeList = negativeData.events ?? (negativeData as unknown as unknown[]);
			expect(negativeList.length).toBeLessThanOrEqual(25);

			const huge = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/events/latest?limit=100000`,
			);
			expect(huge.ok).toBe(true);
			const hugeData = (await huge.json()) as { events?: unknown[] };
			const hugeList = hugeData.events ?? (hugeData as unknown as unknown[]);
			expect(hugeList.length).toBeLessThanOrEqual(100);

			const junk = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/events/latest?limit=abc`,
			);
			expect(junk.ok).toBe(true);
			const junkData = (await junk.json()) as { events?: unknown[] };
			const junkList = junkData.events ?? (junkData as unknown as unknown[]);
			expect(junkList.length).toBeLessThanOrEqual(25);
		},
	);
});
