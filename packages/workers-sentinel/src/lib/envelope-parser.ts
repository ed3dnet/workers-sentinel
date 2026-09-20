import type { EnvelopeHeader, EnvelopeItem, ParsedEnvelope, SentryEvent } from '../types';
import {
	MAX_ATTACHMENT_CONTENT_TYPE_CHARS,
	MAX_ATTACHMENT_FILENAME_CHARS,
	MAX_ATTACHMENTS_PER_ENVELOPE,
} from './attachment-store';
import { EnvelopeFormatError, EnvelopeFramer, type ItemHeader } from './envelope-framer';

const encoder = new TextEncoder();

/**
 * Strict UTF-8 decoder for JSON slices. `fatal: true` rejects invalid byte
 * sequences instead of silently replacing them; `ignoreBOM: true` keeps a
 * leading BOM in the output so JSON.parse rejects it (no BOM in JSON lines).
 */
const jsonDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Lenient decoder for item types whose payload is never read as JSON. */
const lenientDecoder = new TextDecoder('utf-8');

/**
 * Parse a Sentry envelope from a complete byte string or Uint8Array.
 *
 * Collector over the single incremental framing implementation
 * (`EnvelopeFramer`): event/transaction payloads are buffered and JSON.parsed,
 * attachment payloads are collected as raw `Uint8Array` (per-slice text
 * decoding is not the parser's job — payloads live in R2 verbatim). Malformed
 * input anywhere throws `EnvelopeFormatError`, and because the whole
 * envelope is parsed before anything is ingested, a valid-plus-malformed
 * mixed envelope is rejected whole with nothing stored.
 *
 * Accepts a string for the legacy raw-JSON store path and existing callers;
 * strings are UTF-8 encoded before framing. Async because the framer awaits
 * its event handler; feed `EnvelopeFramer` directly for true streaming.
 */
export async function parseEnvelope(input: Uint8Array | string): Promise<ParsedEnvelope> {
	const bytes = typeof input === 'string' ? encoder.encode(input) : input;

	let header: EnvelopeHeader | null = null;
	const items: EnvelopeItem[] = [];
	let current: { header: ItemHeader; chunks: Uint8Array[] } | null = null;

	const finalize = () => {
		const item = current!;
		current = null;
		const payloadBytes = concatChunks(item.chunks);
		const type = item.header.type as EnvelopeItem['type'];
		let payload: unknown;
		if (type === 'event' || type === 'transaction') {
			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonDecoder.decode(payloadBytes));
			} catch {
				throw new EnvelopeFormatError(`Invalid envelope: malformed ${type} payload`);
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new EnvelopeFormatError(`Invalid envelope: ${type} payload is not a JSON object`);
			}
			payload = parsed;
		} else if (type === 'attachment') {
			payload = payloadBytes;
		} else {
			payload = lenientDecoder.decode(payloadBytes);
		}
		items.push({
			type,
			payload,
			length: item.header.length,
			content_type: item.header.content_type,
			filename: item.header.filename,
		});
	};

	const framer = new EnvelopeFramer(async (event) => {
		switch (event.kind) {
			case 'envelope-header':
				header = event.header;
				break;
			case 'item-header':
				current = { header: event.header, chunks: [] };
				break;
			case 'payload-chunk':
				current!.chunks.push(event.chunk);
				break;
			case 'payload-end':
				finalize();
				break;
		}
	});

	await framer.push(bytes);
	await framer.end();

	if (!header) {
		throw new EnvelopeFormatError('Invalid envelope: empty body');
	}
	return { header, items };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Parse DSN from various sources.
 * DSN format: https://{public_key}@{host}/{project_id}
 */
export function parseDSN(dsn: string): {
	protocol: string;
	publicKey: string;
	host: string;
	projectId: string;
} | null {
	try {
		const url = new URL(dsn);
		const publicKey = url.username;
		const pathParts = url.pathname.split('/').filter(Boolean);
		const projectId = pathParts[pathParts.length - 1];

		if (!publicKey || !projectId) {
			return null;
		}

		return {
			protocol: url.protocol.replace(':', ''),
			publicKey,
			host: url.host,
			projectId,
		};
	} catch {
		return null;
	}
}

/**
 * Extract public key from Sentry auth header.
 * Format: Sentry sentry_version=7, sentry_key={key}, ...
 * Tolerant parsing: case-insensitive scheme, trimmed keys, values that
 * themselves contain '=' (e.g. base64) are not truncated.
 */
export function extractKeyFromAuthHeader(header: string): string | null {
	if (!/^\s*sentry\s+/i.test(header)) {
		return null;
	}

	const rest = header.replace(/^\s*sentry\s+/i, '');
	for (const part of rest.split(',')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key === 'sentry_key' && value) {
			return value;
		}
	}

	return null;
}

/**
 * Extract event items from an envelope.
 */
export function extractEvents(envelope: ParsedEnvelope): SentryEvent[] {
	const events: SentryEvent[] = [];

	for (const item of envelope.items) {
		if (item.type === 'event' || item.type === 'transaction') {
			const event = item.payload as SentryEvent;

			// Ensure event_id
			if (!event.event_id) {
				event.event_id = crypto.randomUUID().replace(/-/g, '');
			}

			// Ensure timestamp
			if (!event.timestamp) {
				event.timestamp = new Date().toISOString();
			}

			events.push(event);
		}
	}

	return events;
}

export { EnvelopeFormatError };
export {
	MAX_ATTACHMENTS_PER_ENVELOPE,
	MAX_ATTACHMENT_CONTENT_TYPE_CHARS,
	MAX_ATTACHMENT_FILENAME_CHARS,
};

const MAX_MESSAGE_LENGTH = 8000;
const MAX_STRING_FIELD = 500;
const MAX_TAGS = 50;
const MAX_FRAMES = 100;
const MAX_BREADCRUMBS = 50;
const ALLOWED_LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug']);
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** 36-char dashed UUID (Sentry SDKs commonly send `crypto.randomUUID()`). */
const UUID_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNCASED_EVENT_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * Truncate by Unicode code units without splitting an astral (surrogate)
 * pair: a dangling high surrogate would make later header encoding throw.
 */
function truncateFilenameSafe(value: string, max: number): string {
	if (value.length <= max) return value;
	const sliced = value.slice(0, max);
	const last = sliced.charCodeAt(sliced.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		return sliced.slice(0, -1);
	}
	return sliced;
}

export { truncateFilenameSafe };

/**
 * Validate and bound an incoming event before it reaches storage. Applied in
 * ProjectState so every path (HTTP ingestion, service-binding RPC) is covered:
 * client-controlled identifiers/timestamps are validated or replaced, free-text
 * fields are truncated, and high-cardinality containers are capped.
 */
export function sanitizeEvent(event: SentryEvent): SentryEvent {
	// event_id: normalize dashed UUIDs to the canonical 32-hex form so client
	// ids round-trip; only mint a server id for values that are neither
	// 32-hex nor UUID-shaped. Duplicate detection keys on the normalized id,
	// so dashed and stripped resends are both idempotent replays.
	if (typeof event.event_id === 'string') {
		if (UUID_EVENT_ID_PATTERN.test(event.event_id)) {
			event.event_id = event.event_id.replace(/-/g, '').toLowerCase();
		} else if (UNCASED_EVENT_ID_PATTERN.test(event.event_id)) {
			event.event_id = event.event_id.toLowerCase();
		} else {
			event.event_id = crypto.randomUUID().replace(/-/g, '');
		}
	} else {
		event.event_id = crypto.randomUUID().replace(/-/g, '');
	}
	// invariant for downstream typing: always canonical 32-hex here
	if (!EVENT_ID_PATTERN.test(event.event_id)) {
		event.event_id = crypto.randomUUID().replace(/-/g, '');
	}

	// timestamp: must parse and be within ±1 day of receipt, otherwise use now
	if (typeof event.timestamp === 'string') {
		const parsed = new Date(event.timestamp).getTime();
		const skew = Math.abs(Date.now() - parsed);
		if (!Number.isFinite(parsed) || skew > 24 * 60 * 60 * 1000) {
			event.timestamp = new Date().toISOString();
		}
	} else if (event.timestamp === undefined || event.timestamp === null) {
		event.timestamp = new Date().toISOString();
	}

	// level: known Sentry levels only
	if (typeof event.level !== 'string' || !ALLOWED_LEVELS.has(event.level)) {
		event.level = 'error';
	}

	// platform / environment / release / logger / transaction: bounded strings
	if (typeof event.platform === 'string') {
		event.platform = truncate(event.platform, 64);
	} else {
		event.platform = 'other';
	}
	for (const field of ['environment', 'release', 'logger', 'transaction', 'server_name'] as const) {
		const value = event[field];
		if (typeof value === 'string') {
			(event[field] as string) = truncate(value, MAX_STRING_FIELD);
		}
	}

	if (typeof event.message === 'string') {
		event.message = truncate(event.message, MAX_MESSAGE_LENGTH);
	}

	if (event.exception?.values && Array.isArray(event.exception.values)) {
		for (const exception of event.exception.values) {
			if (typeof exception.value === 'string') {
				exception.value = truncate(exception.value, MAX_MESSAGE_LENGTH);
			}
			if (typeof exception.type === 'string') {
				exception.type = truncate(exception.type, MAX_STRING_FIELD);
			}
			const frames = exception.stacktrace?.frames;
			if (Array.isArray(frames) && frames.length > MAX_FRAMES) {
				exception.stacktrace!.frames = frames.slice(0, MAX_FRAMES);
			}
		}
	}

	if (event.tags && typeof event.tags === 'object' && !Array.isArray(event.tags)) {
		const capped: Record<string, string> = {};
		for (const [key, value] of Object.entries(event.tags).slice(0, MAX_TAGS)) {
			if (typeof value === 'string') {
				capped[truncate(key, MAX_STRING_FIELD)] = truncate(value, MAX_STRING_FIELD);
			}
		}
		event.tags = capped;
	} else {
		event.tags = undefined;
	}

	if (Array.isArray(event.breadcrumbs) && event.breadcrumbs.length > MAX_BREADCRUMBS) {
		event.breadcrumbs = event.breadcrumbs.slice(0, MAX_BREADCRUMBS);
	}

	return event;
}
