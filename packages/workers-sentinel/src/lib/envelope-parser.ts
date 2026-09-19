import type {
	DroppedAttachment,
	EnvelopeHeader,
	EnvelopeItem,
	ExtractedAttachment,
	ParsedEnvelope,
	SentryEvent,
} from '../types';

const NEWLINE = 0x0a;

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
 * Strict UTF-8 decoder for attachment slices. Unlike JSON slices, a leading
 * BOM is meaningful attachment data and is preserved as-is.
 */
const attachmentDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function indexOfByte(bytes: Uint8Array, needle: number, from: number): number {
	for (let i = from; i < bytes.length; i++) {
		if (bytes[i] === needle) return i;
	}
	return -1;
}

/** True when the byte range contains only whitespace (no data). */
function isBlank(bytes: Uint8Array, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		const b = bytes[i];
		if (b !== 0x20 && b !== 0x09 && b !== 0x0d) return false;
	}
	return true;
}

/**
 * Parse a Sentry envelope.
 *
 * Envelope format (byte-level framing per the Sentry envelope spec):
 * ```
 * {header_json}\n
 * {item_header_json}\n
 * {item_payload}\n
 * ...
 * ```
 *
 * When an item header declares `length`, the payload is exactly that many
 * bytes and the newline after it is required only when more bytes follow
 * (EOF at the exact payload boundary is valid). Without `length`, the payload
 * runs to the next newline. Every JSON slice (envelope header, item header,
 * event/transaction payload) is decoded with a fatal UTF-8 decoder and
 * JSON.parse'd: malformed input anywhere throws, and because the whole
 * envelope is parsed before anything is ingested, a valid-plus-malformed
 * mixed envelope is rejected whole with nothing stored. Attachment payloads
 * are kept as raw bytes; per-slice text decoding (and the binary drop
 * decision) happens in `extractAttachments` so a binary attachment cannot
 * poison the envelope parse.
 *
 * Accepts a string for the legacy raw-JSON store path and existing callers;
 * strings are UTF-8 encoded before framing.
 */
export function parseEnvelope(input: Uint8Array | string): ParsedEnvelope {
	const bytes = typeof input === 'string' ? encoder.encode(input) : input;

	if (bytes.length === 0) {
		throw new Error('Invalid envelope: empty body');
	}

	// Envelope header: first line, strict UTF-8, must be a JSON object
	const headerEnd = indexOfByte(bytes, NEWLINE, 0);
	const headerSliceEnd = headerEnd === -1 ? bytes.length : headerEnd;
	let header: EnvelopeHeader;
	try {
		header = JSON.parse(jsonDecoder.decode(bytes.subarray(0, headerSliceEnd)));
	} catch {
		throw new Error('Invalid envelope: failed to parse header');
	}
	if (header === null || typeof header !== 'object' || Array.isArray(header)) {
		throw new Error('Invalid envelope: header is not an object');
	}

	const MAX_ITEMS = 20;
	const items: EnvelopeItem[] = [];
	let pos = headerEnd === -1 ? bytes.length : headerEnd + 1;

	while (pos < bytes.length) {
		const lineEnd = indexOfByte(bytes, NEWLINE, pos);
		const lineEndPos = lineEnd === -1 ? bytes.length : lineEnd;
		// Tolerate blank separator lines (legacy behavior); they carry no data
		// and skipping them cannot misattribute a payload to the wrong item.
		if (isBlank(bytes, pos, lineEndPos)) {
			pos = lineEnd === -1 ? bytes.length : lineEnd + 1;
			continue;
		}

		// Parse item header. A malformed header means the stream is misaligned:
		// silently skipping it would misattribute payloads to the wrong type.
		let itemHeader: {
			type: string;
			length?: number;
			content_type?: unknown;
			filename?: unknown;
		};
		try {
			itemHeader = JSON.parse(jsonDecoder.decode(bytes.subarray(pos, lineEndPos)));
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

		pos = lineEnd === -1 ? bytes.length : lineEnd + 1;

		// Frame the exact payload byte range
		let payloadBytes: Uint8Array;
		if (typeof itemHeader.length === 'number') {
			const declared = itemHeader.length;
			if (!Number.isInteger(declared) || declared < 0) {
				throw new Error('Invalid envelope: invalid item length');
			}
			if (pos + declared > bytes.length) {
				throw new Error('Invalid envelope: truncated item payload');
			}
			payloadBytes = bytes.subarray(pos, pos + declared);
			pos += declared;
			if (pos < bytes.length) {
				if (bytes[pos] !== NEWLINE) {
					throw new Error('Invalid envelope: misaligned item boundary');
				}
				pos += 1;
			}
		} else {
			const payloadEnd = indexOfByte(bytes, NEWLINE, pos);
			const sliceEnd = payloadEnd === -1 ? bytes.length : payloadEnd;
			payloadBytes = bytes.subarray(pos, sliceEnd);
			pos = payloadEnd === -1 ? bytes.length : payloadEnd + 1;
		}

		// Decode per item type
		const type = itemHeader.type as EnvelopeItem['type'];
		let payload: unknown;
		if (type === 'event' || type === 'transaction') {
			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonDecoder.decode(payloadBytes));
			} catch {
				throw new Error(`Invalid envelope: malformed ${type} payload`);
			}
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error(`Invalid envelope: ${type} payload is not a JSON object`);
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
			length: typeof itemHeader.length === 'number' ? itemHeader.length : undefined,
			content_type:
				typeof itemHeader.content_type === 'string' ? itemHeader.content_type : undefined,
			filename: typeof itemHeader.filename === 'string' ? itemHeader.filename : undefined,
		});
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

export const MAX_ATTACHMENT_FILENAME_CHARS = 200;
export const MAX_ATTACHMENT_CONTENT_TYPE_CHARS = 100;
/** Per-attachment payload cap in UTF-8 bytes (from the framed slice). */
export const MAX_ATTACHMENT_DATA_BYTES = 100 * 1024;
export const MAX_ATTACHMENTS_PER_ENVELOPE = 10;

/**
 * Extract text attachments from an envelope.
 *
 * Bounds: filename ≤ 200 chars, contentType ≤ 100 chars, data ≤ 100 KiB
 * UTF-8 bytes (measured on the framed byte slice, not the decoded string's
 * UTF-16 length), ≤ 10 attachments per envelope. Attachment data must be
 * valid UTF-8 text — binary attachments are out of scope by design and drop
 * with `binary_unsupported` without aborting the envelope. Attachment items
 * associate with the envelope's single event: with zero or several events
 * there is no unambiguous owner, so they drop with `no_unique_event`.
 * (`event_filtered` is appended by the ingestion path when the associated
 * event is dropped by an inbound filter.)
 */
export function extractAttachments(
	envelope: ParsedEnvelope,
	events: SentryEvent[] = [],
): { attachments: ExtractedAttachment[]; dropped: DroppedAttachment[] } {
	const attachments: ExtractedAttachment[] = [];
	const dropped: DroppedAttachment[] = [];
	const associable = events.length === 1;

	for (const item of envelope.items) {
		if (item.type !== 'attachment') continue;

		const filename =
			typeof item.filename === 'string' && item.filename.length > 0 ? item.filename : 'attachment';
		const drop = (reason: DroppedAttachment['reason']) => dropped.push({ filename, reason });

		if (!associable) {
			drop('no_unique_event');
			continue;
		}
		if (!(item.payload instanceof Uint8Array)) {
			drop('binary_unsupported');
			continue;
		}
		if (attachments.length >= MAX_ATTACHMENTS_PER_ENVELOPE) {
			drop('too_many');
			continue;
		}
		const size = item.payload.byteLength;
		if (size > MAX_ATTACHMENT_DATA_BYTES) {
			drop('too_large');
			continue;
		}
		let data: string;
		try {
			data = attachmentDecoder.decode(item.payload);
		} catch {
			drop('binary_unsupported');
			continue;
		}
		const contentType =
			typeof item.content_type === 'string' && item.content_type.length > 0
				? item.content_type
				: 'text/plain';

		attachments.push({
			filename: truncateFilenameSafe(filename, MAX_ATTACHMENT_FILENAME_CHARS),
			contentType: truncateFilenameSafe(contentType, MAX_ATTACHMENT_CONTENT_TYPE_CHARS),
			data,
			size,
		});
	}

	return { attachments, dropped };
}

/**
 * Decompress gzip-encoded body if necessary, with a hard cap on the
 * decompressed size so a small gzip bomb cannot exhaust memory. Returns
 * bounded bytes: no whole-body text decode happens here — per-slice decoding
 * happens in the envelope framer, so a binary attachment cannot poison the
 * envelope.
 */
export const MAX_COMPRESSED_BODY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_DECOMPRESSED_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function maybeDecompress(
	body: ArrayBuffer,
	contentEncoding: string | null,
): Promise<Uint8Array> {
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
		return joined;
	}

	return new Uint8Array(body);
}

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
