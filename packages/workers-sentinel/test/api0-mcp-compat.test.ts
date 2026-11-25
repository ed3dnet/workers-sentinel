// /api/0 gaps found by running the official Sentry MCP server
// (@sentry/mcp-server 0.51.0) against Sentinel — docs/compat-mcp-sentry.md:
//  1. issue ids match case-insensitively (the MCP uppercases them);
//  2. the event's `release` is a Release object or null, never a string;
//  3. `notes/` aliases `comments/`, and `activities/` exists;
//  4. `GET /projects/{org}/{project}/` (project detail);
//  5. `GET /auth/` (the token's user, for `whoami`);
//  6. events carry Sentry `entries` (exception frames, breadcrumbs, …).
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { serializeEventEntries } from '../src/lib/sentry-entries';
import { authFetch, createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();
const hexId = () => crypto.randomUUID().replace(/-/g, '');

type Owner = Awaited<ReturnType<typeof createTestUser>>;
type TestProject = Awaited<ReturnType<typeof createTestProject>>;

let owner: Owner;
let apiToken: string;
let project: TestProject;
let issueId: string;
let releasedEventId: string;
let barEventId: string;

async function ingest(target: TestProject, eventId: string, extra: Record<string, unknown>) {
	const envelope = [
		JSON.stringify({ dsn: `https://${target.publicKey}@localhost/${target.id}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			platform: 'javascript',
			level: 'error',
			...extra,
		}),
	].join('\n');
	const response = await SELF.fetch(`http://localhost/api/${target.id}/envelope/`, {
		method: 'POST',
		headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}` },
		body: enc.encode(envelope) as unknown as BodyInit,
	});
	expect(response.status, await response.text()).toBe(200);
}

function api0(path: string, init: RequestInit = {}, token = apiToken) {
	return SELF.fetch(`http://localhost/api/0${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	});
}

beforeAll(async () => {
	owner = await createTestUser({
		email: `api0-mcp-${Date.now()}@example.com`,
		password: 'testpassword123',
		name: 'MCP Compat Owner',
	});
	const tokenResponse = await authFetch(owner.token!, 'http://localhost/api/auth/tokens', {
		method: 'POST',
		body: JSON.stringify({ name: 'mcp compat' }),
	});
	expect(tokenResponse.status).toBe(200);
	apiToken = ((await tokenResponse.json()) as { rawToken: string }).rawToken;

	project = await createTestProject(owner.token!, {
		name: `api0-mcp-${crypto.randomUUID().slice(0, 8)}`,
	});
	// Same message → same issue: one event with a release, one without.
	releasedEventId = hexId();
	barEventId = hexId();
	await ingest(project, releasedEventId, { message: 'mcp compat probe', release: 'web@1.2.3' });
	await ingest(project, barEventId, { message: 'mcp compat probe' });

	const native = await authFetch(
		owner.token!,
		`http://localhost/api/projects/${project.slug}/issues`,
	);
	const issues = ((await native.json()) as { issues: Array<{ id: string }> }).issues;
	expect(issues).toHaveLength(1);
	issueId = issues[0].id;
	expect(issueId).toBe(issueId.toLowerCase());
}, 120_000);

describe('/api/0 issue ids are case-insensitive', () => {
	it('resolves an uppercased id on every issue route', async () => {
		const upper = issueId.toUpperCase();

		const detail = await api0(`/organizations/sentinel/issues/${upper}/`);
		expect(detail.status).toBe(200);
		expect(((await detail.json()) as { id: string }).id).toBe(issueId);

		const alias = await api0(`/issues/${upper}/`);
		expect(alias.status).toBe(200);

		const events = await api0(`/organizations/sentinel/issues/${upper}/events/`);
		expect(events.status).toBe(200);
		const eventList = (await events.json()) as Array<{ groupID: string }>;
		expect(eventList).toHaveLength(2);
		expect(eventList[0].groupID).toBe(issueId);

		const projectEvents = await api0(`/projects/sentinel/${project.slug}/issues/${upper}/events/`);
		expect(projectEvents.status).toBe(200);

		const latest = await api0(`/organizations/sentinel/issues/${upper}/events/latest/`);
		expect(latest.status).toBe(200);

		const concrete = await api0(`/organizations/sentinel/issues/${upper}/events/${barEventId}/`);
		expect(concrete.status).toBe(200);

		const updated = await api0(`/organizations/sentinel/issues/${upper}/`, {
			method: 'PUT',
			body: JSON.stringify({ status: 'unresolved' }),
		});
		expect(updated.status).toBe(200);
		expect(((await updated.json()) as { id: string }).id).toBe(issueId);
	});
});

describe('/api/0 event release is a Release object', () => {
	it('serializes a release string as {version, …} and a missing one as null', async () => {
		const withRelease = await api0(`/projects/sentinel/${project.slug}/events/${releasedEventId}/`);
		expect(withRelease.status).toBe(200);
		const released = (await withRelease.json()) as { release: Record<string, unknown> | null };
		expect(released.release).not.toBeNull();
		expect(released.release?.version).toBe('web@1.2.3');
		expect(released.release?.shortVersion).toBe('web@1.2.3');
		expect(released.release?.lastCommit).toBeNull();

		const without = await api0(`/projects/sentinel/${project.slug}/events/${barEventId}/`);
		expect(((await without.json()) as { release: unknown }).release).toBeNull();

		// Same serializer on the issue event list and the eventids lookup.
		const list = await api0(`/organizations/sentinel/issues/${issueId}/events/`);
		const releases = ((await list.json()) as Array<{ release: unknown }>).map((e) => e.release);
		for (const release of releases) {
			expect(release === null || typeof release === 'object').toBe(true);
		}
		const lookup = await api0(`/organizations/sentinel/eventids/${releasedEventId}/`);
		const envelope = (await lookup.json()) as { event: { release: { version: string } } };
		expect(envelope.event.release.version).toBe('web@1.2.3');
	});
});

describe('/api/0 notes and activities', () => {
	it('notes/ round-trips like comments/, with the text under data.text', async () => {
		const upper = issueId.toUpperCase();
		const created = await api0(`/organizations/sentinel/issues/${upper}/notes/`, {
			method: 'POST',
			body: JSON.stringify({ text: 'mcp triage note' }),
		});
		expect(created.status).toBe(201);
		const note = (await created.json()) as Record<string, unknown>;
		expect(note.type).toBe('note');
		expect(note.data).toEqual({ text: 'mcp triage note' });
		expect(note.text).toBe('mcp triage note');
		expect(note.issueId).toBe(issueId);
		expect((note.user as { name: string }).name).toBe('MCP Compat Owner');

		const notes = await api0(`/organizations/sentinel/issues/${issueId}/notes/`);
		expect(notes.status).toBe(200);
		const noteList = (await notes.json()) as Array<Record<string, unknown>>;
		expect(noteList.map((n) => n.id)).toEqual([note.id]);
		expect(noteList[0].data).toEqual({ text: 'mcp triage note' });

		// Same store as comments/.
		const comments = await api0(`/organizations/sentinel/issues/${issueId}/comments/`);
		expect(((await comments.json()) as Array<{ id: string }>).map((n) => n.id)).toEqual([note.id]);

		const deleted = await api0(`/organizations/sentinel/issues/${upper}/notes/${note.id}/`, {
			method: 'DELETE',
		});
		expect(deleted.status).toBe(204);
		const after = await api0(`/organizations/sentinel/issues/${issueId}/notes/`);
		expect(await after.json()).toEqual([]);
	});

	it('activities/ lists notes and status changes newest first, ending with first_seen', async () => {
		const resolve = await api0(`/organizations/sentinel/issues/${issueId}/`, {
			method: 'PUT',
			body: JSON.stringify({ status: 'resolved' }),
		});
		expect(resolve.status).toBe(200);
		const created = await api0(`/organizations/sentinel/issues/${issueId}/notes/`, {
			method: 'POST',
			body: JSON.stringify({ text: 'resolved by the agent' }),
		});
		const note = (await created.json()) as { id: string };

		const response = await api0(
			`/organizations/sentinel/issues/${issueId.toUpperCase()}/activities/`,
		);
		expect(response.status).toBe(200);
		const { activity } = (await response.json()) as {
			activity: Array<{
				id: string;
				type: string;
				data: Record<string, unknown>;
				dateCreated: string;
				user: { id: string; name: string } | null;
			}>;
		};
		const types = activity.map((entry) => entry.type);
		expect(types[0]).toBe('note');
		expect(types).toContain('set_resolved');
		expect(types[types.length - 1]).toBe('first_seen');

		const noteEntry = activity[0];
		expect(noteEntry.id).toBe(note.id);
		expect(noteEntry.data).toEqual({ text: 'resolved by the agent' });
		expect(noteEntry.user?.id).toBe(owner.id);

		const resolvedEntry = activity.find((entry) => entry.type === 'set_resolved');
		expect(resolvedEntry?.user?.name).toBe('MCP Compat Owner');
		for (const entry of activity) {
			expect(Number.isNaN(Date.parse(entry.dateCreated))).toBe(false);
		}

		const unknown = await api0(`/organizations/sentinel/issues/${crypto.randomUUID()}/activities/`);
		expect(unknown.status).toBe(404);
	});
});

describe('/api/0 project detail', () => {
	it('returns the list serializer by slug or id, 404 otherwise', async () => {
		const bySlug = await api0(`/projects/sentinel/${project.slug}/`);
		expect(bySlug.status).toBe(200);
		const detail = (await bySlug.json()) as Record<string, unknown>;

		const list = await api0('/organizations/sentinel/projects/');
		const entry = ((await list.json()) as Array<Record<string, unknown>>).find(
			(p) => p.id === project.id,
		);
		expect(detail).toEqual(entry);
		expect(detail.slug).toBe(project.slug);

		const byId = await api0(`/projects/sentinel/${project.id}`);
		expect(byId.status).toBe(200);
		expect(((await byId.json()) as { id: string }).id).toBe(project.id);

		const missing = await api0('/projects/sentinel/no-such-project/');
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ detail: 'not found' });

		// Non-members get the same 404.
		const stranger = await createTestUser({
			email: `api0-mcp-stranger-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Stranger',
		});
		const hidden = await api0(`/projects/sentinel/${project.slug}/`, {}, stranger.token!);
		expect(hidden.status).toBe(404);
	});
});

describe('/api/0/auth/', () => {
	it("returns the token's user", async () => {
		for (const path of ['/auth/', '/auth']) {
			const response = await api0(path);
			expect(response.status).toBe(200);
			const user = (await response.json()) as Record<string, unknown>;
			expect(user.id).toBe(owner.id);
			expect(user.email).toBe(owner.email);
			expect(user.name).toBe('MCP Compat Owner');
		}
		// Session tokens work too.
		const session = await api0('/auth/', {}, owner.token!);
		expect(((await session.json()) as { id: string }).id).toBe(owner.id);
	});

	it('rejects anonymous callers with a Sentry-shaped 401', async () => {
		const response = await SELF.fetch('http://localhost/api/0/auth/');
		expect(response.status).toBe(401);
		expect(typeof ((await response.json()) as { detail: unknown }).detail).toBe('string');
	});
});

describe('/api/0 event entries', () => {
	it('serializes exception frames, message, breadcrumbs and request the Sentry way', async () => {
		const richProject = await createTestProject(owner.token!, {
			name: `api0-entries-${crypto.randomUUID().slice(0, 8)}`,
		});
		const eventId = hexId();
		const crumbSeconds = Math.floor(Date.now() / 1000) - 5;
		await ingest(richProject, eventId, {
			platform: 'node',
			message: 'upload failed',
			exception: {
				values: [
					{
						type: 'CLIRuntimeError',
						value: 'connection reset',
						mechanism: { type: 'onunhandledrejection', handled: false },
						stacktrace: {
							frames: [
								{ filename: 'cli.ts', function: 'main', lineno: 12, colno: 3, in_app: true },
								{
									filename: 'publish.ts',
									abs_path: '/app/src/publish.ts',
									function: 'uploadArtifact',
									lineno: 118,
									in_app: true,
									pre_context: ['const body = read();', 'try {'],
									context_line: '  await put(body);',
									post_context: ['} finally {'],
								},
								{ filename: 'node:internal/net', function: 'onread', lineno: 7 },
							],
						},
					},
				],
			},
			breadcrumbs: {
				values: [
					{
						category: 'http',
						message: 'PUT /artifacts',
						timestamp: crumbSeconds,
						data: { status: 500 },
					},
					{
						category: 'console',
						level: 'warning',
						message: 'retrying',
						timestamp: new Date().toISOString(),
					},
				],
			},
			request: {
				url: 'https://example.com/upload?attempt=2#top',
				method: 'PUT',
				headers: { 'User-Agent': 'demo-cli/1.4.2', 'Content-Type': 'application/json' },
			},
		});
		const native = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${richProject.slug}/issues`,
		);
		const richIssue = ((await native.json()) as { issues: Array<{ id: string }> }).issues[0].id;

		const latest = await api0(
			`/organizations/sentinel/issues/${richIssue.toUpperCase()}/events/latest/`,
		);
		expect(latest.status).toBe(200);
		const event = (await latest.json()) as {
			entries: Array<{ type: string; data: Record<string, unknown> }>;
		};
		expect(event.entries.map((entry) => entry.type)).toEqual([
			'exception',
			'message',
			'breadcrumbs',
			'request',
		]);
		const byType = Object.fromEntries(event.entries.map((entry) => [entry.type, entry.data]));

		const exception = (byType.exception.values as Array<Record<string, unknown>>)[0];
		expect(exception.type).toBe('CLIRuntimeError');
		expect(exception.value).toBe('connection reset');
		expect(exception.mechanism).toMatchObject({ type: 'onunhandledrejection', handled: false });
		const frames = (exception.stacktrace as { frames: Array<Record<string, unknown>> }).frames;
		expect(frames).toHaveLength(3);
		expect(frames[0]).toMatchObject({
			filename: 'cli.ts',
			function: 'main',
			lineNo: 12,
			colNo: 3,
			inApp: true,
		});
		expect(frames[1]).toMatchObject({
			absPath: '/app/src/publish.ts',
			lineNo: 118,
			context: [
				[116, 'const body = read();'],
				[117, 'try {'],
				[118, '  await put(body);'],
				[119, '} finally {'],
			],
		});
		expect(frames[2].inApp).toBe(false);
		expect((exception.stacktrace as { hasSystemFrames: boolean }).hasSystemFrames).toBe(true);
		expect(byType.exception.hasSystemFrames).toBe(true);

		expect(byType.message).toMatchObject({ formatted: 'upload failed' });

		const crumbs = byType.breadcrumbs.values as Array<Record<string, unknown>>;
		expect(crumbs[0]).toMatchObject({
			type: 'default',
			category: 'http',
			level: 'info',
			message: 'PUT /artifacts',
			data: { status: 500 },
			timestamp: new Date(crumbSeconds * 1000).toISOString(),
		});
		expect(crumbs[1]).toMatchObject({ level: 'warning', message: 'retrying' });

		expect(byType.request).toMatchObject({
			url: 'https://example.com/upload',
			method: 'PUT',
			query: [['attempt', '2']],
			fragment: 'top',
			headers: [
				['Content-Type', 'application/json'],
				['User-Agent', 'demo-cli/1.4.2'],
			],
			inferredContentType: 'application/json',
		});

		// An event with nothing but a message has just the message entry.
		const plain = await api0(`/projects/sentinel/${project.slug}/events/${barEventId}/`);
		const plainEvent = (await plain.json()) as { entries: Array<{ type: string }> };
		expect(plainEvent.entries).toEqual([
			{ type: 'message', data: { formatted: 'mcp compat probe', message: null, params: null } },
		]);
	});

	it('drops malformed interfaces instead of echoing them', () => {
		expect(serializeEventEntries({})).toEqual([]);
		const entries = serializeEventEntries({
			exception: { values: ['nope', null, { type: 7, stacktrace: { frames: 'x' } }] },
			stacktrace: { frames: [{ function: 'top', lineno: 'NaN', in_app: 'yes' }] },
			threads: [{ id: 1, crashed: true, stacktrace: { frames: [{ function: 'run' }] } }],
			logentry: { message: 'value %s', params: ['x'], formatted: 'value x' },
			breadcrumbs: [42, { message: 'ok', timestamp: 'not a date' }],
			request: { url: '/relative/path', query_string: [['a', 1], ['bad']], headers: 'h' },
		});
		const byType = Object.fromEntries(entries.map((entry) => [entry.type, entry.data]));
		expect(Object.keys(byType)).toEqual([
			'exception',
			'stacktrace',
			'threads',
			'message',
			'breadcrumbs',
			'request',
		]);
		expect(byType.exception).toMatchObject({ values: [{ type: null, stacktrace: null }] });
		expect(byType.stacktrace).toMatchObject({
			frames: [{ function: 'top', lineNo: null, inApp: false }],
		});
		expect(byType.threads).toMatchObject({ values: [{ id: 1, crashed: true }] });
		expect(byType.message).toEqual({ formatted: 'value x', message: 'value %s', params: ['x'] });
		expect(byType.breadcrumbs).toEqual({
			values: [
				{
					type: 'default',
					category: null,
					level: 'info',
					message: 'ok',
					data: null,
					timestamp: null,
					event_id: null,
				},
			],
		});
		expect(byType.request).toMatchObject({ url: null, query: [['a', '1']], headers: [] });
	});
});
