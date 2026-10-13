// Regression: releases keyset pagination must use a composite cursor
// (`last_seen|version`, sort field + id tie-break) per the repo's keyset
// conventions. The previous implementation keyed continuation on the bare
// `last_seen` value (`WHERE last_seen < ?`), so any two releases sharing a
// `last_seen` millisecond at a page boundary were silently skipped — the row
// after the boundary with an equal key is excluded by the strict `<` on every
// subsequent page.
//
// The tie itself is not constructible through the public surface in tests
// (`releases.last_seen` is the server receipt clock, and back-to-back ingests
// never land in the same millisecond — verified 0/24 events), so this test
// pins the mechanism instead: the cursor format and the exact continuation
// semantics that make tied keys page correctly.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

describe('releases keyset pagination', () => {
	test('pages with a composite last_seen|version cursor and never repeats or skips rows', async () => {
		const project = await createTestProject(owner.token!, {
			name: `releases-pagination-${Date.now()}`,
		});

		// Three releases, one event each. Server receipt times are distinct
		// by construction (one ingest per millisecond at most).
		const versions = ['rel-older', 'rel-middle', 'rel-newest'];
		for (const version of versions) {
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const envelope = [
				JSON.stringify({
					event_id: eventId,
					dsn: `https://${project.publicKey}@localhost/${project.id}`,
				}),
				JSON.stringify({ type: 'event' }),
				JSON.stringify({
					event_id: eventId,
					timestamp: new Date().toISOString(),
					platform: 'javascript',
					level: 'error',
					message: `pagination regression ${version}`,
					release: version,
				}),
			].join('\n');
			const response = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-sentry-envelope',
					'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
				},
				body: enc.encode(envelope) as unknown as BodyInit,
			});
			expect(response.status, `ingest failed: ${await response.text()}`).toBe(200);
		}

		const list = async (query: string) => {
			const response = await SELF.fetch(
				`http://localhost/api/projects/${project.slug}/releases${query}`,
				{
					headers: { Authorization: `Bearer ${owner.token}` },
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()) as {
				releases: Array<{ version: string; lastSeen: string }>;
				nextCursor?: string;
				hasMore: boolean;
			};
		};

		const full = await list('?limit=100');
		expect(full.releases).toHaveLength(3);
		expect(full.releases.map((r) => r.version).sort()).toEqual([...versions].sort());
		expect(full.nextCursor).toBeUndefined();
		expect(full.hasMore).toBe(false);

		// Walk one release per page: the cursor must carry the tie-break id so
		// equal `last_seen` values straddling a boundary stay reachable.
		const seen: string[] = [];
		let query = '?limit=1';
		for (let page = 0; page < 5; page++) {
			const data = await list(query);
			expect(data.releases).toHaveLength(1);
			seen.push(data.releases[0].version);
			if (!data.nextCursor) {
				expect(data.hasMore).toBe(false);
				break;
			}
			expect(data.nextCursor).toMatch(/^.+\|.+$/);
			query = `?limit=1&cursor=${encodeURIComponent(data.nextCursor)}`;
		}
		expect(seen).toHaveLength(3);
		expect(new Set(seen).size).toBe(3);
		expect([...seen].sort()).toEqual([...versions].sort());

		// Continuation from a mid-list cursor returns exactly the rows after
		// it — no already-seen rows, no skipped rows.
		const firstPage = await list('?limit=1');
		expect(firstPage.releases[0].version).toBe('rel-newest');
		expect(firstPage.nextCursor).toBeDefined();
		const secondPage = await list(`?limit=100&cursor=${encodeURIComponent(firstPage.nextCursor!)}`);
		expect(secondPage.releases.map((r) => r.version).sort()).toEqual(['rel-middle', 'rel-older']);
		expect(secondPage.hasMore).toBe(false);
		expect(secondPage.nextCursor).toBeUndefined();
	});
});
