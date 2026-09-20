import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

describe('issues cursor pagination', () => {
	it(
		'default sort emits a usable nextCursor that pages to exhaustion',
		{ timeout: 60000 },
		async () => {
			const user = await createTestUser({
				email: `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
				password: 'testpassword123',
				name: 'Cursor User',
			});
			const project = await createTestProject(user.token!, {
				name: `Cursor ${Date.now()}`,
				platform: 'javascript',
			});

			// Three distinct issues with strictly increasing last_seen (the DO
			// stamps ms-resolution ISO timestamps per ingest, so space them)
			for (const type of ['AlphaError', 'BetaError', 'GammaError']) {
				await sendTestEvent(project.id, project.publicKey, {
					exception: { type, value: `cursor probe ${type}` },
				});
				await new Promise((resolve) => setTimeout(resolve, 4));
			}

			const page1 = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/issues?limit=2`,
			);
			if (!page1.ok) throw new Error(`issues page 1 failed: ${await page1.text()}`);
			const data1 = (await page1.json()) as {
				issues: Array<{ id: string; lastSeen: string }>;
				nextCursor?: string;
				hasMore: boolean;
			};
			expect(data1.issues).toHaveLength(2);
			expect(data1.hasMore).toBe(true);
			// The bug this pins: snake_case sort field read from camelCase
			// objects made nextCursor vanish on the default sort
			expect(typeof data1.nextCursor).toBe('string');
			expect(data1.nextCursor).toBe(data1.issues[1].lastSeen);

			const page2 = await authFetch(
				user.token!,
				`http://localhost/api/projects/${project.slug}/issues?limit=2&cursor=${encodeURIComponent(
					data1.nextCursor!,
				)}`,
			);
			if (!page2.ok) throw new Error(`issues page 2 failed: ${await page2.text()}`);
			const data2 = (await page2.json()) as {
				issues: Array<{ id: string }>;
				nextCursor?: string;
				hasMore: boolean;
			};
			expect(data2.issues).toHaveLength(1);
			expect(data2.hasMore).toBe(false);
			expect(data2.nextCursor).toBeUndefined();
			const page1Ids = new Set(data1.issues.map((issue) => issue.id));
			for (const issue of data2.issues) {
				expect(page1Ids.has(issue.id)).toBe(false);
			}
		},
	);
});

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
