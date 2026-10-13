// Regression: the merge endpoint rejected a merge list containing duplicate
// ids with `some_issues_not_found` even though every unique issue existed —
// the DO compared selected-row count to the raw list length, so a client
// resending an id (or building the list from overlapping selections) got a
// misleading 404. Duplicates are now deduped up front (also for the 100-id
// bound), and the merge proceeds on the unique ids. Deterministic, no
// fast-check.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

describe('merge dedupes repeated issue ids', () => {
	test('a merge list with duplicate ids succeeds', async () => {
		const project = await createTestProject(owner.token!, {
			name: `merge-dedupe-${crypto.randomUUID().slice(0, 8)}`,
		});
		const suffix = crypto.randomUUID().slice(0, 6);
		for (const message of [`dedupe A ${suffix}`, `dedupe B ${suffix}`]) {
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const envelope = [
				JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` }),
				JSON.stringify({ type: 'event' }),
				JSON.stringify({
					event_id: eventId,
					timestamp: new Date().toISOString(),
					platform: 'javascript',
					level: 'error',
					message,
				}),
			].join('\n');
			const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
				method: 'POST',
				headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}` },
				body: enc.encode(envelope) as unknown as BodyInit,
			});
			expect(response.status, await response.text()).toBe(200);
		}

		const listResponse = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/issues?limit=10`,
			{
				headers: { Authorization: `Bearer ${owner.token!}` },
			},
		);
		const list = (await listResponse.json()) as { issues: Array<{ id: string }> };
		expect(list.issues).toHaveLength(2);
		const [a, b] = list.issues.map((i) => i.id);

		const merge = await SELF.fetch(`http://localhost/api/projects/${project.slug}/issues/merge`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${owner.token!}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ primaryIssueId: a, issueIds: [a, b, b, a, b] }),
		});
		expect(merge.status, await merge.text()).toBe(200);

		const afterResponse = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/issues?limit=10`,
			{
				headers: { Authorization: `Bearer ${owner.token!}` },
			},
		);
		const after = (await afterResponse.json()) as { issues: Array<{ id: string; count: number }> };
		expect(after.issues).toHaveLength(1);
		expect(after.issues[0].id).toBe(a);
		expect(after.issues[0].count).toBe(2);
	});
});
