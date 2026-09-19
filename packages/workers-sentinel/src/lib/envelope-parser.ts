import type { EnvelopeHeader, EnvelopeItem, ParsedEnvelope, SentryEvent } from '../types';

/**
 * Parse a Sentry envelope.
 * Envelope format:
 * ```
 * {header_json}\n
 * {item_header_json}\n
 * {item_payload_json}\n
 * {item_header_json}\n
 * {item_payload_json}\n
 * ...
 * ```
 */
export function parseEnvelope(body: string): ParsedEnvelope {
	const lines = body.split('\n');

	if (lines.length < 1) {
		throw new Error('Invalid envelope: empty body');
	}

	// Parse envelope header (first line)
	let header: EnvelopeHeader;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		throw new Error('Invalid envelope: failed to parse header');
	}
	if (header === null || typeof header !== 'object') {
		throw new Error('Invalid envelope: header is not an object');
	}

	const MAX_ITEMS = 20;
	const items: EnvelopeItem[] = [];
	let i = 1;

	// Parse items (pairs of header + payload)
	while (i < lines.length) {
		// Skip empty lines
		if (!lines[i] || lines[i].trim() === '') {
			i++;
			continue;
		}

		// Parse item header. A malformed header means the stream is misaligned:
		// silently skipping it would misattribute payloads to the wrong type.
		let itemHeader: { type: string; length?: number; content_type?: string };
		try {
			itemHeader = JSON.parse(lines[i]);
		} catch {
			throw new Error('Invalid envelope: malformed item header');
		}
		if (
			itemHeader === null ||
			typeof itemHeader !== 'object' ||
			typeof itemHeader.type !== 'string'
		) {
			throw new Error('Invalid envelope: item header missing type');
		}

		if (items.length >= MAX_ITEMS) {
			throw new Error('Invalid envelope: too many items');
		}

		i++;

		// Parse item payload
		if (i >= lines.length) {
			break;
		}

		let payload: unknown;

		if (itemHeader.length !== undefined) {
			// Binary/fixed-length payload
			const payloadStr = lines[i].substring(0, itemHeader.length);
			try {
				payload = JSON.parse(payloadStr);
			} catch {
				payload = payloadStr;
			}
		} else {
			// JSON payload. An unparsable payload must not be coerced to a
			// string and stored as if it were structured data.
			try {
				payload = JSON.parse(lines[i]);
			} catch {
				payload = null;
			}
		}

		items.push({
			type: itemHeader.type as EnvelopeItem['type'],
			payload,
		});

		i++;
	}

	return { header, items };
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
 * Validate and extract event items from an envelope.
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

/**
 * Decompress gzip-encoded body if necessary, with a hard cap on the
 * decompressed size so a small gzip bomb cannot exhaust memory.
 */
export const MAX_COMPRESSED_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_DECOMPRESSED_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function maybeDecompress(
	body: ArrayBuffer,
	contentEncoding: string | null,
): Promise<string> {
	if (contentEncoding === 'gzip') {
		const ds = new DecompressionStream('gzip');
		const decompressed = new Response(body).body!.pipeThrough(ds);
		const reader = decompressed.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_DECOMPRESSED_BODY_BYTES) {
				await reader.cancel();
				throw new Error('Decompressed body too large');
			}
			chunks.push(value);
		}
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(joined);
	}

	return new TextDecoder().decode(body);
}

const MAX_MESSAGE_LENGTH = 8000;
const MAX_STRING_FIELD = 500;
const MAX_TAGS = 50;
const MAX_FRAMES = 100;
const MAX_BREADCRUMBS = 50;
const ALLOWED_LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug']);
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validate and bound an incoming event before it reaches storage. Applied in
 * ProjectState so every path (HTTP ingestion, service-binding RPC) is covered:
 * client-controlled identifiers/timestamps are validated or replaced, free-text
 * fields are truncated, and high-cardinality containers are capped.
 */
export function sanitizeEvent(event: SentryEvent): SentryEvent {
	// event_id: must be a 32-char hex string, otherwise replace it
	if (typeof event.event_id !== 'string' || !EVENT_ID_PATTERN.test(event.event_id)) {
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
