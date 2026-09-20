import type { Env } from '../types';

/**
 * Attachment payload storage contract.
 *
 * Blobs live in R2 under an event-independent key layout so a duplicate or
 * replayed envelope can never clobber another event's objects, and so
 * lifecycle/GC join back through the metadata row's `r2_key`:
 *
 * - `p/{projectId}/u/{nonce}/{index}` — fresh uploads. `nonce` is a random id
 *   minted per ingest request, `index` is the attachment ordinal in the
 *   envelope. Retry resends upload under a fresh nonce; the originals stay
 *   referenced by their committed rows.
 * - `p/{projectId}/m/{attachmentId}` — deterministic keys for rows migrated
 *   from legacy inline storage.
 *
 * Filenames never appear in keys.
 */
export function attachmentKey(projectId: string, nonce: string, index: number): string {
	return `p/${projectId}/u/${nonce}/${index}`;
}

export function migrationKey(projectId: string, attachmentId: string): string {
	return `p/${projectId}/m/${attachmentId}`;
}

/** Every object belonging to one project shares this prefix (purge/GC sweep). */
export function projectPrefix(projectId: string): string {
	return `p/${projectId}/`;
}

// ---------------------------------------------------------------------------
// Caps (single source of truth; re-exported by the envelope parser for
// compatibility with existing imports)
// ---------------------------------------------------------------------------

/**
 * Total attachment payload bytes allowed in one envelope, measured on the
 * bytes as received/stored. Clients that zstd-compress individual payloads
 * on their side are bounded on the compressed bytes they send: the server
 * stores those bytes verbatim.
 */
export const MAX_ATTACHMENT_BYTES_PER_ENVELOPE = 21 * 1024 * 1024; // 21 MiB

/**
 * Wire (pre-decompression) request body cap. Absorbs a fully
 * budget-compliant envelope sent uncompressed: 21 MiB attachments + 5 MiB
 * non-attachment payloads + framing slack, so a budget-compliant envelope is
 * never wire-rejected.
 */
export const MAX_COMPRESSED_BODY_BYTES = 27 * 1024 * 1024; // 27 MiB

/**
 * Hard ceiling on decompressed request bytes. Covers kept payloads, drained
 * (dropped/oversized) payloads, and separator junk alike — every decompressed
 * byte counts.
 */
export const MAX_DECOMPRESSED_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Bound for the envelope-header line and each item-header line. */
export const MAX_LINE_BYTES = 64 * 1024; // 64 KiB

/**
 * Bound for an attachment payload without a declared `length`. Length-less
 * payloads are newline-delimited, so binary without `length` is unsafe by
 * protocol; such payloads are buffered whole before upload and stay small.
 */
export const MAX_UNFRAMED_ATTACHMENT_BYTES = 1024 * 1024; // 1 MiB

/** Storable attachments per envelope (the 11th+ drop with `too_many`). */
export const MAX_ATTACHMENTS_PER_ENVELOPE = 10;

export const MAX_ATTACHMENT_FILENAME_CHARS = 200;
export const MAX_ATTACHMENT_CONTENT_TYPE_CHARS = 100;

/**
 * Shared budget for buffered non-attachment item payloads (event/transaction
 * JSON) in one envelope. Keeps worker memory bounded while streaming.
 */
export const MAX_NONATTACHMENT_ITEM_BYTES = 5 * 1024 * 1024; // 5 MiB

// ---------------------------------------------------------------------------
// Fault injection (test infrastructure)
// ---------------------------------------------------------------------------

/**
 * Fault vocabulary, honored only when the `ATTACHMENT_FAULT_INJECTION` binding
 * equals `'enabled'` (test-only miniflare config; never present in
 * production):
 *
 * - `put` — the first `put` fails.
 * - `put-after:N` — the (N+1)th `put` fails (after N successful puts).
 * - `purge-sweep` — the purge prefix sweep fails once.
 * - `migration-flip` — persists a one-shot marker (alarms carry no headers)
 *   that makes the next alarm migration run treat the first row's conditional
 *   flip as if the row had been deleted mid-flight.
 */
export type AttachmentFaultMode = 'put' | `put-after:${number}` | 'purge-sweep' | 'migration-flip';

/** Parse the `X-Sentinel-Test-Fault` header value; null when absent/unknown. */
export function parseFaultMode(header: string | undefined | null): AttachmentFaultMode | null {
	if (!header) return null;
	if (header === 'put' || header === 'purge-sweep' || header === 'migration-flip') return header;
	const match = /^put-after:(\d+)$/.exec(header);
	if (match) return `put-after:${Number.parseInt(match[1], 10)}` as const;
	return null;
}

/** Fault mode for a request, or null when fault injection is not enabled. */
export function activeFaultMode(
	env: Env,
	header: string | undefined | null,
): AttachmentFaultMode | null {
	if (env.ATTACHMENT_FAULT_INJECTION !== 'enabled') return null;
	return parseFaultMode(header);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Raised when a bucket operation (put/delete/list) fails. Deliberately
 * narrow: only genuine bucket-operation failures map to 503 — client framing
 * errors stay 400.
 */
export class AttachmentStorageError extends Error {
	constructor(
		message: string,
		readonly operation: 'put' | 'delete' | 'list',
	) {
		super(message);
		this.name = 'AttachmentStorageError';
	}
}

/** One page of a prefix listing. `cursor` is null when the listing is done. */
export interface R2Page {
	objects: R2Object[];
	cursor: string | null;
}

const LIST_PAGE_SIZE = 1000; // R2 maximum
const DELETE_BATCH_SIZE = 1000; // R2 maximum

export interface AttachmentStore {
	/**
	 * Upload one payload. `value` may be a stream (already length-fixed by the
	 * caller via `FixedLengthStream` when the declared length is known) or a
	 * buffer. `expectedSize` is informational for fault bookkeeping.
	 */
	uploadAttachment(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView,
		expectedSize: number,
	): Promise<void>;
	/** Delete keys in ≤1000-key batches. */
	deleteKeys(keys: string[]): Promise<void>;
	/**
	 * List one page of a prefix (drives purge and GC scans; callers persist
	 * the cursor for continuation). The `purge-sweep` fault fails the first
	 * listing exactly once per store instance.
	 */
	listPage(prefix: string, cursor?: string | null): Promise<R2Page>;
}

/**
 * Per-request store factory. All mutable fault/bookkeeping state lives in the
 * returned instance — there is no module-level state, so concurrent requests
 * sharing an isolate cannot observe each other's faults.
 */
export function createAttachmentStore(
	env: Env,
	faultMode: AttachmentFaultMode | null,
): AttachmentStore {
	const bucket = env.ATTACHMENTS;
	let successfulPuts = 0;
	let putFaultFired = false;
	let sweepFaultFired = false;

	const putShouldFail = (): boolean => {
		if (putFaultFired) return false;
		if (faultMode === 'put' && successfulPuts === 0) return true;
		if (typeof faultMode === 'string' && faultMode.startsWith('put-after:')) {
			const after = Number.parseInt(faultMode.slice('put-after:'.length), 10);
			if (successfulPuts >= after) return true;
		}
		return false;
	};

	return {
		async uploadAttachment(key, value, expectedSize) {
			if (putShouldFail()) {
				putFaultFired = true;
				throw new AttachmentStorageError(
					`fault-injected put failure (${expectedSize} bytes for ${key})`,
					'put',
				);
			}
			try {
				await bucket.put(key, value);
				successfulPuts++;
			} catch (error) {
				throw new AttachmentStorageError(
					`R2 put failed for ${key}: ${
						error instanceof Error ? error.message.slice(0, 120) : 'unknown'
					}`,
					'put',
				);
			}
		},

		async deleteKeys(keys) {
			for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
				const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
				if (batch.length === 0) continue;
				try {
					await bucket.delete(batch);
				} catch (error) {
					throw new AttachmentStorageError(
						`R2 delete failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
						'delete',
					);
				}
			}
		},

		async listPage(prefix, cursor) {
			if (faultMode === 'purge-sweep' && !sweepFaultFired) {
				sweepFaultFired = true;
				throw new AttachmentStorageError(
					`fault-injected sweep failure for prefix ${prefix}`,
					'list',
				);
			}
			try {
				const result = await bucket.list({
					prefix,
					cursor: cursor ?? undefined,
					limit: LIST_PAGE_SIZE,
				});
				return { objects: result.objects, cursor: result.truncated ? result.cursor : null };
			} catch (error) {
				throw new AttachmentStorageError(
					`R2 list failed for prefix ${prefix}: ${
						error instanceof Error ? error.message.slice(0, 120) : 'unknown'
					}`,
					'list',
				);
			}
		},
	};
}
