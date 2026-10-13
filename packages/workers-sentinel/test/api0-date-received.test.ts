// Regression: the /api/0 event serializer populated BOTH dateCreated and
// dateReceived from the CLIENT timestamp — but dateReceived must mean receipt
// time (Sentry semantics), and the stored received_at column was never
// exposed anywhere. The DO's event reads now carry receivedAt (the server
// receipt clock) alongside the event JSON, and the serializer uses it for
// dateReceived, keeping dateCreated as the client timestamp. Deterministic
// regression, no fast-check.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();

let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
	owner = await createTestUser();
});

describe('/api/0 dateReceived is receipt time', () => {
	test('dateCreated echoes the client timestamp; dateReceived is the receipt clock', async () => {
		const project = await createTestProject(owner.token!, {
			name: `api0-recv-${crypto.randomUUID().slice(0, 8)}`,
		});
		const clientTimestamp = new Date(Date.now() - 30 * 60_000).toISOString();
		const eventId = crypto.randomUUID().replace(/-/g, '');
		const envelope = [
			JSON.stringify({ dsn: `https://${project.publicKey}@localhost/${project.id}` }),
			JSON.stringify({ type: 'event' }),
			JSON.stringify({
				event_id: eventId,
				timestamp: clientTimestamp,
				platform: 'javascript',
				level: 'error',
				message: 'dateReceived probe',
			}),
		].join('\n');
		const ingestResponse = await SELF.fetch(`http://localhost/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}` },
			body: enc.encode(envelope) as unknown as BodyInit,
		});
		expect(ingestResponse.status, await ingestResponse.text()).toBe(200);

		const before = Date.now();
		const detail = await SELF.fetch(
			`http://localhost/api/0/projects/sentinel/${project.slug}/events/${eventId}/`,
			{ headers: { Authorization: `Bearer ${owner.token!}` } },
		);
		expect(detail.status).toBe(200);
		const event = (await detail.json()) as { dateCreated: string; dateReceived: string };
		expect(event.dateCreated).toBe(clientTimestamp);
		// Receipt time: within a minute of now — NOT the 30-minutes-old client time.
		const received = new Date(event.dateReceived).getTime();
		expect(Math.abs(received - before)).toBeLessThanOrEqual(60_000);

		// The eventids lookup envelope carries the same corrected serializer.
		const lookup = await SELF.fetch(
			`http://localhost/api/0/organizations/sentinel/eventids/${eventId}/`,
			{ headers: { Authorization: `Bearer ${owner.token!}` } },
		);
		expect(lookup.status).toBe(200);
		const lookupEvent = ((await lookup.json()) as { event: { dateReceived: string } }).event;
		const lookupReceived = new Date(lookupEvent.dateReceived).getTime();
		expect(Math.abs(lookupReceived - before)).toBeLessThanOrEqual(60_000);
	});
});
