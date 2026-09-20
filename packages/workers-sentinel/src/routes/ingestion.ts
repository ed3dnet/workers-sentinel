import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	AttachmentStorageError,
	type AttachmentStore,
	activeFaultMode,
	attachmentKey,
	createAttachmentStore,
	MAX_ATTACHMENT_BYTES_PER_ENVELOPE,
	MAX_ATTACHMENT_CONTENT_TYPE_CHARS,
	MAX_ATTACHMENT_FILENAME_CHARS,
	MAX_ATTACHMENTS_PER_ENVELOPE,
	MAX_COMPRESSED_BODY_BYTES,
	MAX_DECOMPRESSED_BODY_BYTES,
	MAX_NONATTACHMENT_ITEM_BYTES,
	MAX_UNFRAMED_ATTACHMENT_BYTES,
} from '../lib/attachment-store';
import {
	EnvelopeFormatError,
	EnvelopeFramer,
	type EnvelopeFramerEvent,
	type ItemHeader,
} from '../lib/envelope-framer';
import { extractKeyFromAuthHeader, truncateFilenameSafe } from '../lib/envelope-parser';
import { buildWebhookPayload, sendWebhook } from '../lib/webhook';
import type { DroppedAttachment, Env, Project, SentryEvent } from '../types';

export const ingestionRoutes = new Hono<{ Bindings: Env }>();

const strictJsonDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Sentry browser SDKs POST cross-origin without credentials: these endpoints
// get permissive CORS (wildcard origin, NO credentials). This is the only part
// of the API that may be reached cross-origin by design.
for (const path of [
	'/:projectId/envelope',
	'/:projectId/envelope/',
	'/:projectId/store',
	'/:projectId/store/',
	'/:projectId/security',
]) {
	ingestionRoutes.use(path, cors({ origin: '*', credentials: false }));
}

// Main envelope ingestion endpoint
// POST /api/{project_id}/envelope/
ingestionRoutes.post('/:projectId/envelope', handleIngestion);
ingestionRoutes.post('/:projectId/envelope/', handleIngestion);

// Legacy store endpoint (for older SDKs)
// POST /api/{project_id}/store/
ingestionRoutes.post('/:projectId/store', handleIngestion);
ingestionRoutes.post('/:projectId/store/', handleIngestion);

/** Rate-limit signal from the lazy DO touch, raised before any upload. */
class EarlyRateLimitError extends Error {
	constructor(readonly retryAfter: string) {
		super('rate limited');
		this.name = 'EarlyRateLimitError';
	}
}

/** Decompressed request body passed the hard 64 MiB ceiling. */
class DecompressedTooLargeError extends Error {
	constructor() {
		super('Decompressed body too large');
		this.name = 'DecompressedTooLargeError';
	}
}

/** Attachment metadata committed (or pending commit) for one envelope. */
interface UploadedAttachment {
	filename: string;
	contentType: string;
	size: number;
	r2Key: string;
}

type ItemSink =
	| { kind: 'drain' }
	| { kind: 'event-buffer'; itemType: 'event' | 'transaction'; chunks: Uint8Array[]; bytes: number }
	| {
			kind: 'attachment-stream';
			writer: WritableStreamDefaultWriter<Uint8Array>;
			key: string;
			upload: Promise<void>;
			filename: string;
			contentType: string;
			size: number;
	  }
	| {
			kind: 'attachment-buffer';
			chunks: Uint8Array[];
			bytes: number;
			key: string;
			filename: string;
			contentType: string;
			dropped: boolean;
	  };

/**
 * Consumes framer events for one ingest request: buffers event/transaction
 * payloads under a shared 5 MiB budget, streams in-budget attachments into
 * R2 (`FixedLengthStream` supplies the content length), buffers length-less
 * attachments up to 1 MiB, and drains everything else. Envelope attachment
 * cardinality (≤10, running total ≤21 MiB) is decided here from the item
 * header before any payload byte is consumed; policy drops are nonfatal.
 */
class StreamingIngest {
	readonly events: SentryEvent[] = [];
	/** Defaulted filenames of every attachment item, in envelope order. */
	readonly attachmentNames: string[] = [];
	readonly droppedEarly: DroppedAttachment[] = [];
	readonly uploaded: UploadedAttachment[] = [];

	private readonly framer: EnvelopeFramer;
	private readonly nonce = crypto.randomUUID().replace(/-/g, '');
	private runningBytes = 0;
	private storableCount = 0;
	private ordinal = 0;
	private touched = false;
	private sink: ItemSink = { kind: 'drain' };

	constructor(
		private readonly projectId: string,
		private readonly store: AttachmentStore,
		private readonly projectState: DurableObjectStub,
	) {
		this.framer = new EnvelopeFramer(async (event) => {
			if (this.failure !== null) return; // first failure wins; drain
			try {
				await this.onEvent(event);
			} catch (error) {
				this.failure = error;
			}
		});
	}

	get uploadedKeys(): string[] {
		return this.uploaded.map((a) => a.r2Key);
	}

	/** Attachment metadata for the DO ingest call (payload stays in R2). */
	get attachmentMeta(): Array<{
		filename: string;
		contentType: string;
		size: number;
		r2Key: string;
	}> {
		return this.uploaded.map(({ filename, contentType, size, r2Key }) => ({
			filename,
			contentType,
			size,
			r2Key,
		}));
	}

	push(chunk: Uint8Array): Promise<void> {
		return this.framer.push(chunk);
	}

	finish(): Promise<void> {
		return this.framer.end();
	}

	/**
	 * First handler failure, if any. Event handlers never throw across the
	 * framer boundary (workerd flags such rejections as unhandled even when
	 * awaited): failures are recorded here and re-raised from the caller's
	 * frame at the next checkpoint. Once set, all further events are ignored
	 * (no additional uploads, buffers, or parses).
	 */
	private failure: unknown = null;

	get failed(): boolean {
		return this.failure !== null;
	}

	/** Re-raise the recorded failure from this frame. */
	raiseIfFailed(): void {
		if (this.failure !== null) {
			throw this.failure;
		}
	}

	/** First failure wins; later errors cannot mask the original cause. */
	private recordFailure(error: unknown): void {
		if (this.failure === null) {
			this.failure = error;
		}
	}

	/** Abandon any in-flight stream upload (envelope failed; R2 puts are atomic). */
	abort(): void {
		if (this.sink.kind === 'attachment-stream') {
			void this.sink.writer.abort(new Error('envelope aborted')).catch(() => {});
		}
	}

	/**
	 * Lazily touch the ProjectState DO at the first storable attachment
	 * (before its first upload): ensures the schema exists and an alarm is
	 * scheduled, so any blob orphaned by a later failure is within GC
	 * coverage even when no event is ever ingested. Also returns the
	 * rate-limit snapshot so a limited project is rejected before up to
	 * 21 MiB of otherwise-doomed uploads.
	 */
	private async ensureTouched(): Promise<void> {
		if (this.touched) return;
		this.touched = true;
		const response = await this.projectState.fetch(
			new Request('http://internal/touch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: this.projectId }),
			}),
		);
		if (response.ok) {
			const data = (await response.json()) as { isLimited?: boolean; retryAfterSeconds?: number };
			if (data.isLimited) {
				throw new EarlyRateLimitError(String(data.retryAfterSeconds ?? 3600));
			}
		}
		// Non-ok touch: fall through — the ingest call surfaces real errors.
	}

	private async onEvent(event: EnvelopeFramerEvent): Promise<void> {
		switch (event.kind) {
			case 'envelope-header':
				return;
			case 'item-header':
				return this.onItemHeader(event.header);
			case 'payload-chunk':
				return this.onPayloadChunk(event.chunk);
			case 'payload-end':
				return this.onPayloadEnd();
		}
	}

	private drop(filename: string, reason: DroppedAttachment['reason']): void {
		this.droppedEarly.push({ filename, reason });
	}

	private onItemHeader(header: ItemHeader): Promise<void> | void {
		const type = header.type;
		if (type === 'event' || type === 'transaction') {
			this.sink = { kind: 'event-buffer', itemType: type, chunks: [], bytes: 0 };
			return;
		}
		if (type !== 'attachment') {
			// client_report etc.: framed, drained, counted only toward the
			// decompressed ceiling by the read loop
			this.sink = { kind: 'drain' };
			return;
		}

		// Attachment: default (untruncated) filename for drop reports,
		// truncated values for stored metadata — matching the old extractor.
		const filename =
			typeof header.filename === 'string' && header.filename.length > 0
				? header.filename
				: 'attachment';
		this.attachmentNames.push(filename);
		const ordinal = this.ordinal++;
		const storedFilename = truncateFilenameSafe(filename, MAX_ATTACHMENT_FILENAME_CHARS);
		const contentType = truncateFilenameSafe(
			typeof header.content_type === 'string' && header.content_type.length > 0
				? header.content_type
				: 'text/plain',
			MAX_ATTACHMENT_CONTENT_TYPE_CHARS,
		);

		if (this.storableCount >= MAX_ATTACHMENTS_PER_ENVELOPE) {
			this.drop(filename, 'too_many');
			this.sink = { kind: 'drain' };
			return;
		}

		if (header.length !== undefined) {
			if (this.runningBytes + header.length > MAX_ATTACHMENT_BYTES_PER_ENVELOPE) {
				this.drop(filename, 'too_large');
				this.sink = { kind: 'drain' };
				return;
			}
			// Caps decided from the header before consuming the payload:
			// stream straight into R2 via a length-fixed stream.
			return this.beginStreamUpload(header.length, storedFilename, contentType, ordinal);
		}

		// No declared length: newline-delimited payload, buffered whole under
		// a 1 MiB cap before upload (binary without `length` is unsafe by
		// protocol — documented; the framer's handling is deterministic).
		this.sink = {
			kind: 'attachment-buffer',
			chunks: [],
			bytes: 0,
			key: attachmentKey(this.projectId, this.nonce, ordinal),
			filename: storedFilename,
			contentType,
			dropped: false,
		};
	}

	private async beginStreamUpload(
		size: number,
		filename: string,
		contentType: string,
		ordinal: number,
	): Promise<void> {
		try {
			await this.ensureTouched();
		} catch (error) {
			this.failure = error; // EarlyRateLimitError / DO fetch failure
			return;
		}
		const key = attachmentKey(this.projectId, this.nonce, ordinal);
		const fixed = new FixedLengthStream(size);
		const writer = fixed.writable.getWriter();
		const upload = this.store.uploadAttachment(key, fixed.readable, size);
		// If the upload rejects before consuming the stream (e.g. a faulted
		// put), abort the writer so payload writes fail fast instead of
		// blocking on backpressure forever. The true upload error is recorded
		// first so the writer's abort error cannot mask it.
		upload.catch((error: unknown) => {
			this.recordFailure(error);
			void writer.abort(new Error('attachment upload failed')).catch(() => {});
		});
		this.sink = { kind: 'attachment-stream', writer, key, upload, filename, contentType, size };
		this.storableCount++;
		this.runningBytes += size;
	}

	private onPayloadChunk(chunk: Uint8Array): Promise<void> | void {
		if (this.failure !== null) return; // draining a failed envelope
		const sink = this.sink;
		switch (sink.kind) {
			case 'drain':
				return;
			case 'event-buffer': {
				sink.chunks.push(chunk);
				sink.bytes += chunk.byteLength;
				if (sink.bytes > MAX_NONATTACHMENT_ITEM_BYTES) {
					this.recordFailure(new EnvelopeFormatError('Invalid envelope: item payload too large'));
				}
				return;
			}
			case 'attachment-stream':
				// Backpressure matters (the reader loop awaits this write);
				// failures are recorded, never thrown across the boundary.
				return sink.writer.write(chunk).catch((error: unknown) => {
					this.recordFailure(error);
				});
			case 'attachment-buffer': {
				if (sink.dropped) return;
				if (sink.bytes + chunk.byteLength > MAX_UNFRAMED_ATTACHMENT_BYTES) {
					sink.dropped = true;
					sink.chunks = [];
					this.drop(sink.filename, 'too_large');
					return;
				}
				sink.chunks.push(chunk);
				sink.bytes += chunk.byteLength;
				return;
			}
		}
	}

	private async onPayloadEnd(): Promise<void> {
		if (this.failure !== null) {
			this.sink = { kind: 'drain' };
			return; // draining a failed envelope
		}
		const sink = this.sink;
		this.sink = { kind: 'drain' };
		switch (sink.kind) {
			case 'drain':
				return;
			case 'event-buffer': {
				const bytes = concatChunks(sink.chunks);
				let parsed: unknown;
				try {
					parsed = JSON.parse(strictJsonDecoder.decode(bytes));
				} catch {
					this.recordFailure(
						new EnvelopeFormatError(`Invalid envelope: malformed ${sink.itemType} payload`),
					);
					return;
				}
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					this.recordFailure(
						new EnvelopeFormatError(
							`Invalid envelope: ${sink.itemType} payload is not a JSON object`,
						),
					);
					return;
				}
				this.events.push(parsed as SentryEvent);
				return;
			}
			case 'attachment-stream': {
				try {
					await sink.writer.close();
					await sink.upload; // storage failure → recorded → 503
				} catch (error) {
					this.recordFailure(error);
					return;
				}
				this.uploaded.push({
					filename: sink.filename,
					contentType: sink.contentType,
					size: sink.size,
					r2Key: sink.key,
				});
				return;
			}
			case 'attachment-buffer': {
				if (sink.dropped) return;
				const bytes = concatChunks(sink.chunks);
				if (this.runningBytes + bytes.byteLength > MAX_ATTACHMENT_BYTES_PER_ENVELOPE) {
					this.drop(sink.filename, 'too_large');
					return;
				}
				try {
					await this.ensureTouched();
					// AttachmentStorageError → recorded → 503 (never a policy drop)
					await this.store.uploadAttachment(sink.key, bytes, bytes.byteLength);
				} catch (error) {
					this.recordFailure(error);
					return;
				}
				this.storableCount++;
				this.runningBytes += bytes.byteLength;
				this.uploaded.push({
					filename: sink.filename,
					contentType: sink.contentType,
					size: bytes.byteLength,
					r2Key: sink.key,
				});
				return;
			}
		}
	}
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

async function handleIngestion(c: Context<{ Bindings: Env }>): Promise<Response> {
	const projectId = c.req.param('projectId');

	// Extract public key from various sources
	let publicKey: string | null = null;

	// 1. Query parameter: ?sentry_key=xxx
	const sentryKeyParam = c.req.query('sentry_key');
	if (sentryKeyParam) {
		publicKey = sentryKeyParam;
	}

	// 2. X-Sentry-Auth header: Sentry sentry_version=7, sentry_key=xxx, ...
	if (!publicKey) {
		const authHeader = c.req.header('X-Sentry-Auth');
		if (authHeader) {
			publicKey = extractKeyFromAuthHeader(authHeader);
		}
	}

	// 3. Authorization header (basic auth style)
	if (!publicKey) {
		const authHeader = c.req.header('Authorization');
		if (authHeader && /^\s*basic\s+/i.test(authHeader)) {
			try {
				const decoded = atob(authHeader.replace(/^\s*basic\s+/i, ''));
				publicKey = decoded.split(':')[0];
			} catch {
				// Invalid base64
			}
		}
	}

	if (!publicKey) {
		return c.json({ error: 'missing_auth', message: 'No authentication provided' }, 401);
	}

	// Validate the public key against the project
	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const projectResponse = await authState.fetch(
		new Request('http://internal/get-project-by-key', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ publicKey }),
		}),
	);

	if (!projectResponse.ok) {
		return c.json({ error: 'invalid_auth', message: 'Invalid DSN' }, 401);
	}

	const projectData = (await projectResponse.json()) as { project: Project };
	const project = projectData.project;

	// Verify project ID matches (if provided in URL)
	if (projectId && projectId !== project.id) {
		return c.json({ error: 'project_mismatch', message: 'Project ID does not match DSN' }, 400);
	}

	const projectStateId = c.env.PROJECT_STATE.idFromName(project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	// Per-request store: fault mode (if any) is derived from the request
	// header and honored only under the test binding — no module state.
	const store = createAttachmentStore(
		c.env,
		activeFaultMode(c.env, c.req.header('X-Sentinel-Test-Fault')),
	);
	const ingest = new StreamingIngest(project.id, store, projectState);

	// Wire cap precheck (streamed counter below catches lying/chunked bodies)
	const contentEncoding = c.req.header('Content-Encoding') ?? null;
	const contentType = c.req.header('Content-Type') || '';
	const declaredLength = Number(c.req.header('Content-Length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPRESSED_BODY_BYTES) {
		return c.json({ error: 'payload_too_large', message: 'Envelope exceeds size limit' }, 413);
	}

	const rawBody = c.req.raw.body;
	if (!rawBody) {
		return c.json({ error: 'parse_failed', message: 'Failed to parse envelope' }, 400);
	}

	// Count wire bytes as they arrive; decompress when gzip-encoded. The
	// worker never buffers the whole envelope: chunks flow through the wire
	// counter and decompressor into the framer as they are read.
	let wireBytes = 0;
	let stream: ReadableStream<Uint8Array> = rawBody.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				wireBytes += chunk.byteLength;
				if (wireBytes > MAX_COMPRESSED_BODY_BYTES) {
					throw new Error('Envelope exceeds size limit');
				}
				controller.enqueue(chunk);
			},
		}),
	);
	if (contentEncoding === 'gzip') {
		stream = stream.pipeThrough(new DecompressionStream('gzip'));
	}
	const reader = stream.getReader();

	// Legacy raw-JSON dispatch (store endpoint): an envelope always contains
	// a newline followed by an item header object; a bare JSON event does
	// not. Buffer a bounded prefix while scanning for the `\n{` byte pair,
	// then either parse the bounded JSON (≤5 MiB) or hand the prefix to the
	// framer and keep streaming.
	const maybeRawJson = contentType.includes('application/json');
	let rawDecision: 'undecided' | 'envelope' | 'raw' = maybeRawJson ? 'undecided' : 'envelope';
	let rawPrefix: Uint8Array[] = [];
	let rawPrefixBytes = 0;
	let lastByte = -1;

	// Every decompressed byte counts toward the hard ceiling — payloads
	// kept, drained, or separator junk alike.
	let decompressedBytes = 0;

	let rawEvent: SentryEvent | null = null;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			decompressedBytes += value.byteLength;
			if (decompressedBytes > MAX_DECOMPRESSED_BODY_BYTES) {
				throw new DecompressedTooLargeError();
			}
			if (rawDecision === 'undecided') {
				let found = lastByte === 0x0a && value.length > 0 && value[0] === 0x7b;
				if (!found) {
					for (let i = 1; i < value.length; i++) {
						if (value[i - 1] === 0x0a && value[i] === 0x7b) {
							found = true;
							break;
						}
					}
				}
				if (!found) {
					rawPrefix.push(value);
					rawPrefixBytes += value.byteLength;
					if (rawPrefixBytes <= MAX_NONATTACHMENT_ITEM_BYTES) {
						lastByte = value[value.length - 1];
						continue;
					}
					// Bounded prefix exhausted without the pattern: cannot be
					// raw JSON — treat as envelope (the framer rejects
					// non-envelope bodies with 400).
					rawDecision = 'envelope';
				} else {
					rawDecision = 'envelope';
				}
				for (const part of rawPrefix) {
					await ingest.push(part);
					ingest.raiseIfFailed();
				}
				rawPrefix = [];
			}
			await ingest.push(value);
			ingest.raiseIfFailed();
		}

		if (rawDecision === 'undecided') {
			// EOF without the envelope byte pattern: legacy raw JSON event
			rawDecision = 'raw';
			const bytes = concatChunks(rawPrefix);
			try {
				rawEvent = JSON.parse(strictJsonDecoder.decode(bytes)) as SentryEvent;
			} catch {
				return c.json({ error: 'parse_failed', message: 'Failed to parse envelope' }, 400);
			}
		} else {
			await ingest.finish();
			ingest.raiseIfFailed();
		}
	} catch (error) {
		ingest.abort();
		await reader.cancel().catch(() => {});
		// Blobs uploaded for earlier items are GC fodder within the reclaim
		// window; deleting them outright when possible just speeds that up.
		await bestEffortDelete(store, ingest.uploadedKeys);
		return mapIngestError(error, wireBytes, contentEncoding, c);
	}

	// Envelope cardinality is decided in the worker — the DO never sees
	// event counts.
	const events: SentryEvent[] = rawEvent ? [rawEvent] : ingest.events;

	if (events.length === 0) {
		await bestEffortDelete(store, ingest.uploadedKeys);
		return c.json({
			id: null,
			message: 'No events in envelope',
			droppedAttachments: ingest.attachmentNames.map((filename) => ({
				filename,
				reason: 'no_unique_event' as const,
			})),
		});
	}

	const singleEvent = events.length === 1 ? events[0] : null;
	const attachmentMeta = rawEvent ? [] : ingest.attachmentMeta;
	let dropped: DroppedAttachment[];

	if (singleEvent) {
		dropped = [...ingest.droppedEarly];
	} else {
		// Zero or several events: no unambiguous owner. Every attachment
		// drops with no_unique_event (which replaces earlier per-item
		// reasons), and any uploaded blobs are deleted outright.
		dropped = ingest.attachmentNames.map((filename) => ({
			filename,
			reason: 'no_unique_event' as const,
		}));
		await bestEffortDelete(store, ingest.uploadedKeys);
	}

	// Ingest each event
	const results = [];
	for (const event of events) {
		try {
			const response = await projectState.fetch(
				new Request(
					singleEvent ? 'http://internal/ingest-with-attachments' : 'http://internal/ingest',
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: singleEvent
							? JSON.stringify({
									event: singleEvent,
									attachments: attachmentMeta,
									projectId: project.id,
								})
							: JSON.stringify(event),
					},
				),
			);

			if (response.status === 429) {
				const retryAfter = response.headers.get('Retry-After') || '3600';
				return c.json(
					{ error: 'rate_limited', message: 'Project event quota exceeded' },
					{ status: 429, headers: { 'Retry-After': retryAfter } },
				);
			}

			if (response.ok) {
				const result = await response.json();
				results.push(result);
				const r = result as {
					droppedAttachments?: DroppedAttachment[];
					storedR2Keys?: string[];
				};
				if (Array.isArray(r.droppedAttachments)) {
					dropped.push(...r.droppedAttachments);
				}
				if (singleEvent) {
					// Post-commit hygiene: blobs whose metadata was not
					// committed (quota drops, filtered event, duplicate
					// replay) are deleted; committed keys are kept.
					const committed = new Set(Array.isArray(r.storedR2Keys) ? r.storedR2Keys : []);
					const orphans = ingest.uploadedKeys.filter((key) => !committed.has(key));
					await bestEffortDelete(store, orphans);
				}
			} else {
				// Log status only: response bodies may echo attacker content
				console.error(`Ingest error: status ${response.status}`);
			}
		} catch (error) {
			console.error(
				'Ingest error:',
				error instanceof Error ? error.message.slice(0, 200) : 'unknown',
			);
		}
	}

	// Fire webhooks for new issues (non-blocking)
	if (project.webhookUrl) {
		for (const result of results) {
			const r = result as {
				eventId: string;
				issueId: string;
				isNewIssue?: boolean;
				title?: string;
				level?: string;
				culprit?: string | null;
			};
			if (r.isNewIssue && r.title) {
				const payload = buildWebhookPayload(
					{ id: project.id, name: project.name, slug: project.slug },
					{
						id: r.issueId,
						title: r.title,
						level: r.level || 'error',
						culprit: r.culprit || null,
					},
				);
				c.executionCtx.waitUntil(sendWebhook(project.webhookUrl, payload));
			}
		}
	}

	// Return the first event ID (standard Sentry response)
	const firstResult = results[0] as { eventId: string; duplicate?: boolean } | undefined;
	return c.json({
		id: firstResult?.eventId || events[0]?.event_id || null,
		...(firstResult?.duplicate ? { duplicate: true } : {}),
		droppedAttachments: dropped,
	});
}

async function bestEffortDelete(store: AttachmentStore, keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	try {
		await store.deleteKeys(keys);
	} catch {
		// GC backstop reclaims within the reclaim window
	}
}

function mapIngestError(
	error: unknown,
	wireBytes: number,
	contentEncoding: string | null,
	c: Context<{ Bindings: Env }>,
): Response {
	if (error instanceof EarlyRateLimitError) {
		return c.json(
			{ error: 'rate_limited', message: 'Project event quota exceeded' },
			{ status: 429, headers: { 'Retry-After': error.retryAfter } },
		);
	}
	if (error instanceof AttachmentStorageError) {
		// Bucket-operation failure: abort the whole envelope — no DO ingest
		// call, no event, no metadata. Retry behavior is client/transport
		// dependent (official sentry-javascript transports do not auto-resend
		// non-2xx responses).
		return c.json(
			{ error: 'attachment_storage_failed', message: 'Attachment storage failed' },
			{ status: 503, headers: { 'Retry-After': '5' } },
		);
	}
	if (error instanceof DecompressedTooLargeError) {
		return c.json({ error: 'payload_too_large', message: 'Envelope exceeds size limit' }, 413);
	}
	if (wireBytes > MAX_COMPRESSED_BODY_BYTES) {
		return c.json({ error: 'payload_too_large', message: 'Envelope exceeds size limit' }, 413);
	}
	if (contentEncoding === 'gzip') {
		// Mid-body gzip stream error
		return c.json({ error: 'decompression_failed', message: 'Failed to decompress body' }, 400);
	}
	// Framing/JSON/UTF-8 violations (EnvelopeFormatError) and stream errors
	return c.json({ error: 'parse_failed', message: 'Failed to parse envelope' }, 400);
}

// Security endpoint - returns the project's real ingestion security config
// GET /api/{project_id}/security/
ingestionRoutes.get('/:projectId/security', async (c) => {
	const projectId = c.req.param('projectId');
	const projectStateId = c.env.PROJECT_STATE.idFromName(projectId);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);
	const settingsResponse = await projectState.fetch(
		new Request('http://internal/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		}),
	);
	const settings = settingsResponse.ok
		? ((await settingsResponse.json()) as { scrubHeaders?: string[] })
		: {};
	return c.json({
		allowedDomains: ['*'],
		scrubData: true,
		scrubHeaders: settings.scrubHeaders ?? [],
	});
});
