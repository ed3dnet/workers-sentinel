#!/usr/bin/env node
// Production fetch-side smoke test. Run after `wrangler deploy` against the
// live worker (defaults to https://aw-heck.ed3d.net):
//
//   node scripts/prod-smoke-fetch.mjs \
//     --dsn https://<publicKey>@aw-heck.ed3d.net/<projectId> \
//     --slug polytoken-feedback
//
// Authed checks additionally need a throwaway API token in the environment:
//
//   SENTINEL_SMOKE_TOKEN=wst_... node scripts/prod-smoke-fetch.mjs --dsn ... --slug ...
//
// The token is only used read-only here; revoke it afterwards (DELETE
// /api/auth/tokens/:id). Without a token the authed checks are skipped and
// the equivalent curls are printed so an operator can run them by hand.
//
// Checks:
//   1. GET /api/health                                  → 200
//   2. GET /api/nope/                                   → JSON 404 (not SPA HTML)
//   3. POST /api/auth/register (probe)                  → 403 registration_disabled
//   4. POST envelope: event + text attachment via DSN   → 200, normalized id, no drops
//   5. GET /api/projects/:slug/events/:id/attachments   → metadata (authed)
//   6. GET /api/projects/:slug/attachments/:id          → byte-identical download (authed)

import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		base: { type: 'string', default: 'https://aw-heck.ed3d.net' },
		dsn: { type: 'string', default: process.env.SENTINEL_SMOKE_DSN },
		slug: { type: 'string', default: process.env.SENTINEL_SMOKE_SLUG ?? 'polytoken-feedback' },
		help: { type: 'boolean', default: false },
	},
});

if (values.help) {
	console.log(
		'usage: node scripts/prod-smoke-fetch.mjs --dsn <dsn> [--slug <slug>] [--base <url>]',
	);
	process.exit(0);
}

const BASE = values.base.replace(/\/$/, '');
const TOKEN = process.env.SENTINEL_SMOKE_TOKEN;

if (!values.dsn) {
	console.error('missing --dsn (or SENTINEL_SMOKE_DSN): the ingestion DSN of the test project');
	process.exit(1);
}

let publicKey;
let projectId;
try {
	const url = new URL(values.dsn);
	publicKey = url.username;
	projectId = url.pathname.split('/').filter(Boolean).pop();
} catch {
	// fall through to the checks below
}
if (!publicKey || !projectId) {
	console.error(`could not parse DSN: ${values.dsn}`);
	process.exit(1);
}

const enc = new TextEncoder();
const failures = [];
const warnings = [];

function ok(message) {
	console.log(`  ✓ ${message}`);
}

function fail(message) {
	failures.push(message);
	console.error(`  ✗ ${message}`);
}

function warn(message) {
	warnings.push(message);
	console.warn(`  ! ${message}`);
}

async function fetchJson(path, init) {
	const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000), ...init });
	const text = await response.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	return { status: response.status, headers: response.headers, data, text };
}

console.log(`prod fetch-side smoke against ${BASE} (project ${projectId}, slug ${values.slug})`);

// 1. Health
{
	const health = await fetchJson('/api/health');
	if (health.status === 200 && health.data?.status === 'ok') {
		ok('/api/health is 200');
	} else {
		fail(`/api/health: expected 200 ok, got ${health.status} ${JSON.stringify(health.data)}`);
	}
}

// 2. Unknown API path is a JSON 404, not the SPA
{
	const nope = await fetchJson('/api/nope/');
	if (nope.status === 404 && nope.headers.get('Content-Type')?.includes('application/json')) {
		if (nope.data?.error === 'not_found') {
			ok('/api/nope/ returns JSON 404 {"error":"not_found"}');
		} else {
			fail(`/api/nope/ body: expected {"error":"not_found"}, got ${nope.text.slice(0, 120)}`);
		}
	} else {
		fail(`/api/nope/: expected 404 JSON, got ${nope.status} ${nope.headers.get('Content-Type')}`);
	}
}

// 3. Registration state (expected closed). This probe has a valid shape: on a
// closed server it stops at the 403 with no side effects; if registration is
// open it WILL create a member account — reported below for cleanup.
{
	const probeEmail = `smoke-probe-${Date.now()}@sentinel.invalid`;
	const register = await fetchJson('/api/auth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: probeEmail,
			password: 'smoke-probe-password',
			name: 'Fetch Smoke Probe',
		}),
	});
	if (register.status === 403 && register.data?.error === 'registration_disabled') {
		ok('registration is closed (403 registration_disabled)');
	} else {
		warn(
			`registration appears OPEN (probe returned ${register.status} ${
				register.data?.error ?? ''
			}); if an account was created, delete ${probeEmail} (member, no projects)`,
		);
	}
}

// 4. Ingest one envelope with a text attachment via the DSN
const dashed = crypto.randomUUID();
const normalized = dashed.replaceAll('-', '');
const attachment = 'prod smoke attachment\nline two — ünïcode 🛡️\n';
const attachmentBytes = enc.encode(attachment);
{
	const envelope = new Uint8Array([
		...enc.encode(
			`${JSON.stringify({ event_id: dashed, dsn: values.dsn })}\n` +
				`${JSON.stringify({ type: 'event' })}\n` +
				`${JSON.stringify({
					event_id: dashed,
					timestamp: new Date().toISOString(),
					platform: 'node',
					level: 'info',
					message: 'prod fetch-side smoke',
				})}\n` +
				`${JSON.stringify({
					type: 'attachment',
					filename: 'prod-smoke.log',
					content_type: 'text/plain',
					length: attachmentBytes.byteLength,
				})}\n`,
		),
		...attachmentBytes,
	]);
	const ingest = await fetchJson(`/api/${projectId}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
		},
		body: envelope,
	});
	if (ingest.status !== 200) {
		fail(`ingest: expected 200, got ${ingest.status} ${JSON.stringify(ingest.data)}`);
	} else if (ingest.data?.id !== normalized) {
		fail(`ingest: expected normalized id ${normalized}, got ${JSON.stringify(ingest.data?.id)}`);
	} else if (JSON.stringify(ingest.data?.droppedAttachments ?? null) !== '[]') {
		fail(
			`ingest: expected empty droppedAttachments, got ${JSON.stringify(
				ingest.data?.droppedAttachments,
			)}`,
		);
	} else {
		ok(`ingest 200 with normalized echoed id and empty droppedAttachments (${normalized})`);
	}
}

// 5+6. Authed attachment fetch (list + byte-identical download)
if (TOKEN) {
	const authed = { headers: { Authorization: `Bearer ${TOKEN}` } };
	const list = await fetchJson(
		`/api/projects/${values.slug}/events/${normalized}/attachments`,
		authed,
	);
	if (list.status === 200 && list.data?.attachments?.length === 1) {
		const meta = list.data.attachments[0];
		ok(`attachment list: 1 attachment (${meta.filename}, ${meta.size} bytes)`);
		if (meta.size !== attachmentBytes.byteLength) {
			fail(`attachment size: expected ${attachmentBytes.byteLength}, got ${meta.size}`);
		}
		const download = await fetch(`${BASE}/api/projects/${values.slug}/attachments/${meta.id}`, {
			...authed,
			signal: AbortSignal.timeout(30_000),
		});
		const received = new Uint8Array(await download.arrayBuffer());
		const disposition = download.headers.get('Content-Disposition') ?? '';
		if (download.status !== 200) {
			fail(`attachment download: expected 200, got ${download.status}`);
		} else if (
			received.byteLength !== attachmentBytes.byteLength ||
			!received.every((b, i) => b === attachmentBytes[i])
		) {
			fail('attachment download: bytes differ from the ingested payload');
		} else if (!disposition.includes('attachment')) {
			fail(`attachment download: unexpected Content-Disposition: ${disposition}`);
		} else {
			ok(`attachment download is byte-identical (${download.headers.get('Content-Type')})`);
		}
	} else {
		fail(
			`attachment list: expected 200 with 1 attachment, got ${list.status} ${JSON.stringify(
				list.data,
			).slice(0, 200)}`,
		);
	}
	console.log('  ℹ revoke the throwaway token now: DELETE /api/auth/tokens/:id');
} else {
	warn(
		`SENTINEL_SMOKE_TOKEN not set — authed checks skipped. Run by hand:\n` +
			`    curl -sH "Authorization: Bearer wst_…" ${BASE}/api/projects/${values.slug}/events/${normalized}/attachments\n` +
			`    curl -sH "Authorization: Bearer wst_…" ${BASE}/api/projects/${values.slug}/attachments/<attachmentId>`,
	);
}

if (failures.length > 0) {
	console.error(`\nSMOKE FAILED: ${failures.length} check(s) failed`);
	process.exit(1);
}
console.log(`\nsmoke passed${warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ''}`);
