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
//   5. POST envelope: binary + ~2 MiB compressible text attachments (R2 path)
//                                                        → 200, no drops
//   6. GET /api/projects/:slug/events/:id/attachments   → metadata (authed)
//   7. GET /api/projects/:slug/attachments/:id          → byte-identical download (authed)
//   8. Range request on the large attachment            → 206 with the exact slice (authed)

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

// 5. Ingest a second envelope exercising the R2 blob path: a small
// non-UTF-8 binary attachment plus a ~2 MiB compressible text attachment
// (the 21 MiB ceiling is covered by unit tests; smoke keeps payloads lean)
const binaryDashed = crypto.randomUUID();
const binaryNormalized = binaryDashed.replaceAll('-', '');
const binaryBytes = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x81, 0xc3, 0x28,
]);
const line = 'prod smoke compressible line — the quick brown fox jumps over the lazy dog\n';
const bigTextBytes = enc.encode(line.repeat(40_000)); // ~2.9 MiB
{
	const envelope = new Uint8Array([
		...enc.encode(
			`${JSON.stringify({ event_id: binaryDashed, dsn: values.dsn })}\n` +
				`${JSON.stringify({ type: 'event' })}\n` +
				`${JSON.stringify({
					event_id: binaryDashed,
					timestamp: new Date().toISOString(),
					platform: 'node',
					level: 'info',
					message: 'prod fetch-side smoke (binary + large attachments)',
				})}\n` +
				`${JSON.stringify({
					type: 'attachment',
					filename: 'prod-smoke.bin',
					content_type: 'application/octet-stream',
					length: binaryBytes.byteLength,
				})}\n`,
		),
		...binaryBytes,
		...enc.encode('\n'),
		...enc.encode(
			`${JSON.stringify({
				type: 'attachment',
				filename: 'prod-smoke-large.log',
				content_type: 'text/plain',
				length: bigTextBytes.byteLength,
			})}\n`,
		),
		...bigTextBytes,
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
		fail(`binary ingest: expected 200, got ${ingest.status} ${JSON.stringify(ingest.data)}`);
	} else if (JSON.stringify(ingest.data?.droppedAttachments ?? null) !== '[]') {
		fail(
			`binary ingest: expected empty droppedAttachments, got ${JSON.stringify(
				ingest.data?.droppedAttachments,
			)}`,
		);
	} else {
		ok(
			`binary + ${(bigTextBytes.byteLength / 1024 / 1024).toFixed(1)} MiB attachments ingested with no drops`,
		);
	}
}

// 6+7+8. Authed attachment fetches (list + byte-identical downloads + range)
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

	// Binary + large attachment round-trips through R2, plus a range slice
	const binList = await fetchJson(
		`/api/projects/${values.slug}/events/${binaryNormalized}/attachments`,
		authed,
	);
	if (binList.status === 200 && binList.data?.attachments?.length === 2) {
		const bin = binList.data.attachments.find((a) => a.filename === 'prod-smoke.bin');
		const large = binList.data.attachments.find((a) => a.filename === 'prod-smoke-large.log');
		const binDownload = await fetch(`${BASE}/api/projects/${values.slug}/attachments/${bin.id}`, {
			...authed,
			signal: AbortSignal.timeout(30_000),
		});
		const binReceived = new Uint8Array(await binDownload.arrayBuffer());
		if (binDownload.status !== 200) {
			fail(`binary download: expected 200, got ${binDownload.status}`);
		} else if (
			binReceived.byteLength !== binaryBytes.byteLength ||
			!binReceived.every((b, i) => b === binaryBytes[i])
		) {
			fail('binary download: bytes differ (non-UTF-8 payload not stored verbatim?)');
		} else if (binDownload.headers.get('Content-Type') !== 'application/octet-stream') {
			fail(
				`binary download: expected stored content type, got ${binDownload.headers.get('Content-Type')}`,
			);
		} else {
			ok('non-UTF-8 binary attachment downloads byte-identically from R2');
		}

		const largeDownload = await fetch(
			`${BASE}/api/projects/${values.slug}/attachments/${large.id}`,
			{
				...authed,
				signal: AbortSignal.timeout(60_000),
			},
		);
		const largeReceived = new Uint8Array(await largeDownload.arrayBuffer());
		if (largeDownload.status !== 200 || largeReceived.byteLength !== large?.size) {
			fail(
				`large download: expected 200 with ${large?.size} bytes, got ${largeDownload.status} ${largeReceived.byteLength}`,
			);
		} else {
			ok(`${(largeReceived.byteLength / 1024 / 1024).toFixed(1)} MiB attachment downloads from R2`);
		}

		// Range: exact slice with 206 + Content-Range
		const rangeStart = 1024;
		const rangeEnd = 2047;
		const ranged = await fetch(`${BASE}/api/projects/${values.slug}/attachments/${large.id}`, {
			headers: { Authorization: `Bearer ${TOKEN}`, Range: `bytes=${rangeStart}-${rangeEnd}` },
			signal: AbortSignal.timeout(30_000),
		});
		const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
		const expectedSlice = bigTextBytes.subarray(rangeStart, rangeEnd + 1);
		if (ranged.status !== 206) {
			fail(`range download: expected 206, got ${ranged.status}`);
		} else if (
			ranged.headers.get('Content-Range') !== `bytes ${rangeStart}-${rangeEnd}/${large.size}`
		) {
			fail(`range download: unexpected Content-Range ${ranged.headers.get('Content-Range')}`);
		} else if (
			rangedBytes.byteLength !== expectedSlice.byteLength ||
			!rangedBytes.every((b, i) => b === expectedSlice[i])
		) {
			fail('range download: byte slice differs');
		} else {
			ok(`range request returns 206 with the exact ${expectedSlice.byteLength}-byte slice`);
		}
	} else {
		fail(
			`binary attachment list: expected 200 with 2 attachments, got ${binList.status} ${JSON.stringify(
				binList.data,
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
