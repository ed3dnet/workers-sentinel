// Regression: merging issues destroyed the merged-away issues' comments and
// release associations. The DO re-pointed events, summed stats/users/
// environments, then deleted the secondaries — and the schema's ON DELETE
// CASCADE silently wiped issue_comments, issue_activity, and release_issues
// rows for those issues with no migration. A triage note left on a secondary
// issue vanished from the project entirely after the merge.
//
// The merge handler now migrates comments and activity to the primary and
// upserts release links (additive event counts) before deleting secondaries.
// Deterministic regression, no fast-check.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

async function ingest(
	project: { id: string; publicKey: string },
	spec: { message: string; release?: string },
): Promise<void> {
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const envelope = [
		JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			platform: 'javascript',
			level: 'error',
			message: spec.message,
			...(spec.release ? { release: spec.release } : {}),
		}),
	].join('\n');
	const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}` },
		body: enc.encode(envelope) as unknown as BodyInit,
	});
	expect(response.status, await response.text()).toBe(200);
}

async function authJson<T>(
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; data: T }> {
	const response = await SELF.fetch(`http://localhost/api/projects${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${owner.token!}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, data: text ? JSON.parse(text) : (null as T) };
}

describe('merge migrates secondary issue content', () => {
	test('a comment on the merged-away issue survives on the primary', async () => {
		const project = await createTestProject(owner.token!, {
			name: `merge-migrate-${crypto.randomUUID().slice(0, 8)}`,
		});
		const suffix = crypto.randomUUID().slice(0, 6);
		await ingest(project, { message: `migrate A ${suffix}` });
		await ingest(project, { message: `migrate B ${suffix}` });

		const list = await authJson<{ issues: Array<{ id: string }> }>(
			`/${project.slug}/issues?limit=10`,
		);
		expect(list.data.issues).toHaveLength(2);
		const primary = list.data.issues[0].id;
		const secondary = list.data.issues[1].id;

		const note = await authJson(`/${project.slug}/issues/${secondary}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body: 'triage note on secondary' }),
		});
		expect(note.status).toBe(201);

		const merge = await authJson(`/${project.slug}/issues/merge`, {
			method: 'POST',
			body: JSON.stringify({ primaryIssueId: primary, issueIds: [primary, secondary] }),
		});
		expect(merge.status, JSON.stringify(merge.data)).toBe(200);

		const comments = await authJson<{ comments: Array<{ body: string }> }>(
			`/${project.slug}/issues/${primary}/comments`,
		);
		expect(comments.data.comments.some((c) => c.body === 'triage note on secondary')).toBe(true);
	});

	test('release links merge additively: the release keeps its issue, counts add', async () => {
		const project = await createTestProject(owner.token!, {
			name: `merge-rel-${crypto.randomUUID().slice(0, 8)}`,
		});
		const suffix = crypto.randomUUID().slice(0, 6);
		const release = `rel-${suffix}`;
		// Two distinct issues; issue A carries two events (same message).
		await ingest(project, { message: `rel shared A ${suffix}`, release });
		await ingest(project, { message: `rel shared A ${suffix}`, release });
		await ingest(project, { message: `rel B ${suffix}`, release });

		const list = await authJson<{ issues: Array<{ id: string }> }>(
			`/${project.slug}/issues?limit=10`,
		);
		expect(list.data.issues).toHaveLength(2);
		const primary = list.data.issues[0].id;
		const secondary = list.data.issues[1].id;

		const merge = await authJson(`/${project.slug}/issues/merge`, {
			method: 'POST',
			body: JSON.stringify({ primaryIssueId: primary, issueIds: [primary, secondary] }),
		});
		expect(merge.status).toBe(200);

		// The release now links exactly one issue with all three events.
		const releaseDetail = await authJson<{
			release: { version: string; issueCount: number; eventCount: number };
		}>(`/${project.slug}/releases/${encodeURIComponent(release)}`);
		expect(releaseDetail.status).toBe(200);
		expect(releaseDetail.data.release.issueCount).toBe(1);
		expect(releaseDetail.data.release.eventCount).toBe(3);
	});
});
