import type { EnvelopeHeader } from '../types';
import { MAX_LINE_BYTES } from './attachment-store';

/**
 * Incremental Sentry envelope framer.
 *
 * One implementation of the byte-level envelope framing, fed decompressed
 * chunks as they arrive so callers never need the whole body in memory:
 *
 * ```
 * {envelope_header_json}\n
 * {item_header_json}\n
 * {item_payload}\n
 * ...
 * ```
 *
 * When an item header declares `length`, the payload is exactly that many
 * bytes and the newline after it is required only when more bytes follow
 * (EOF at the exact payload boundary is valid). Without `length`, the payload
 * runs to the next newline. Blank separator lines are tolerated between
 * items. Every JSON slice (envelope header, item header, event/transaction
 * payload) is decoded with a fatal UTF-8 decoder — malformed input anywhere
 * throws. Event/transaction payload JSON validation happens in the consumer
 * at `payload-end` (the streaming route) or in the collector, always before
 * anything is ingested.
 *
 * Semantics are preserved byte-for-byte from the previous whole-body parser;
 * additionally the envelope-header line and each item-header line are each
 * buffered up to `MAX_LINE_BYTES` (over → `EnvelopeFormatError`, a client
 * error). Payload bytes are handed through without accumulation: the
 * consumer decides what to buffer (bounded) or stream.
 */

/** Client-side framing/parse error → HTTP 400. */
export class EnvelopeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EnvelopeFormatError';
	}
}

/** A parsed item header. `length` is a validated non-negative integer when present. */
export interface ItemHeader {
	type: string;
	length?: number;
	content_type?: string;
	filename?: string;
}

export type EnvelopeFramerEvent =
	| { kind: 'envelope-header'; header: EnvelopeHeader }
	| { kind: 'item-header'; header: ItemHeader }
	| { kind: 'payload-chunk'; chunk: Uint8Array }
	| { kind: 'payload-end' };

const NEWLINE = 0x0a;

/**
 * Strict UTF-8 decoder for JSON slices. `fatal: true` rejects invalid byte
 * sequences instead of silently replacing them; `ignoreBOM: true` keeps a
 * leading BOM in the output so JSON.parse rejects it (no BOM in JSON lines).
 */
const jsonDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** True when the byte range contains only whitespace (no data). */
function isBlank(bytes: Uint8Array): boolean {
	for (const b of bytes) {
		if (b !== 0x20 && b !== 0x09 && b !== 0x0d) return false;
	}
	return true;
}

type Mode =
	| 'envelope-header'
	| 'item-header'
	| 'framed-payload'
	| 'post-framed-newline'
	| 'unframed-payload'
	| 'done';

const MAX_ITEMS = 20;

export class EnvelopeFramer {
	private mode: Mode = 'envelope-header';
	/** Accumulated header-line bytes (bounded by MAX_LINE_BYTES). */
	private line: Uint8Array | null = null;
	private itemCount = 0;
	private framedRemaining = 0;

	constructor(private readonly onEvent: (event: EnvelopeFramerEvent) => void | Promise<void>) {}

	private async emit(event: EnvelopeFramerEvent): Promise<void> {
		await this.onEvent(event);
	}

	private appendLine(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		const existing = this.line;
		const merged = new Uint8Array((existing?.length ?? 0) + chunk.length);
		if (existing) merged.set(existing, 0);
		merged.set(chunk, existing?.length ?? 0);
		if (merged.length > MAX_LINE_BYTES) {
			throw new EnvelopeFormatError(
				this.mode === 'envelope-header'
					? 'Invalid envelope: header line too long'
					: 'Invalid envelope: item header line too long',
			);
		}
		this.line = merged;
	}

	/** Parse the completed buffered line depending on the current mode. */
	private async finishLine(): Promise<void> {
		const bytes = this.line ?? new Uint8Array(0);
		this.line = null;

		if (this.mode === 'envelope-header') {
			// The envelope header is the first line and is never blank-skipped:
			// a blank first line fails JSON.parse exactly like the old parser.
			let header: EnvelopeHeader;
			try {
				header = JSON.parse(jsonDecoder.decode(bytes));
			} catch {
				throw new EnvelopeFormatError('Invalid envelope: failed to parse header');
			}
			if (header === null || typeof header !== 'object' || Array.isArray(header)) {
				throw new EnvelopeFormatError('Invalid envelope: header is not an object');
			}
			this.mode = 'item-header';
			await this.emit({ kind: 'envelope-header', header });
			return;
		}

		// item-header: tolerate blank separator lines (they carry no data and
		// skipping them cannot misattribute a payload to the wrong item)
		if (isBlank(bytes)) return;

		let itemHeader: {
			type: string;
			length?: number;
			content_type?: unknown;
			filename?: unknown;
		};
		try {
			itemHeader = JSON.parse(jsonDecoder.decode(bytes));
		} catch {
			throw new EnvelopeFormatError('Invalid envelope: malformed item header');
		}
		if (
			itemHeader === null ||
			typeof itemHeader !== 'object' ||
			typeof (itemHeader as { type?: unknown }).type !== 'string'
		) {
			throw new EnvelopeFormatError('Invalid envelope: item header missing type');
		}

		if (this.itemCount >= MAX_ITEMS) {
			throw new EnvelopeFormatError('Invalid envelope: too many items');
		}

		const header: ItemHeader = {
			type: itemHeader.type,
			length: typeof itemHeader.length === 'number' ? itemHeader.length : undefined,
			content_type:
				typeof itemHeader.content_type === 'string' ? itemHeader.content_type : undefined,
			filename: typeof itemHeader.filename === 'string' ? itemHeader.filename : undefined,
		};

		if (header.length !== undefined) {
			if (!Number.isInteger(header.length) || header.length < 0) {
				throw new EnvelopeFormatError('Invalid envelope: invalid item length');
			}
		}

		this.itemCount++;
		await this.emit({ kind: 'item-header', header });

		if (header.length !== undefined) {
			this.framedRemaining = header.length;
			this.mode = 'framed-payload';
			if (header.length === 0) {
				await this.emit({ kind: 'payload-end' });
				this.mode = 'post-framed-newline';
			}
		} else {
			this.mode = 'unframed-payload';
		}
	}

	/** Feed one decompressed chunk. Throws EnvelopeFormatError on framing violations. */
	async push(chunk: Uint8Array): Promise<void> {
		if (this.mode === 'done') {
			throw new EnvelopeFormatError('Invalid envelope: data after end()');
		}
		let pos = 0;
		while (pos < chunk.length) {
			switch (this.mode) {
				case 'envelope-header':
				case 'item-header': {
					const nl = chunk.indexOf(NEWLINE, pos);
					if (nl === -1) {
						this.appendLine(chunk.subarray(pos));
						pos = chunk.length;
					} else {
						this.appendLine(chunk.subarray(pos, nl));
						pos = nl + 1;
						await this.finishLine();
					}
					break;
				}
				case 'framed-payload': {
					const take = Math.min(this.framedRemaining, chunk.length - pos);
					if (take > 0) {
						await this.emit({ kind: 'payload-chunk', chunk: chunk.subarray(pos, pos + take) });
						this.framedRemaining -= take;
						pos += take;
					}
					if (this.framedRemaining === 0) {
						await this.emit({ kind: 'payload-end' });
						this.mode = 'post-framed-newline';
					}
					break;
				}
				case 'post-framed-newline': {
					// More bytes follow a length-delimited payload: the very
					// next byte must be the newline separator.
					if (chunk[pos] !== NEWLINE) {
						throw new EnvelopeFormatError('Invalid envelope: misaligned item boundary');
					}
					pos += 1;
					this.mode = 'item-header';
					break;
				}
				case 'unframed-payload': {
					const nl = chunk.indexOf(NEWLINE, pos);
					if (nl === -1) {
						if (chunk.length > pos) {
							await this.emit({ kind: 'payload-chunk', chunk: chunk.subarray(pos) });
						}
						pos = chunk.length;
					} else {
						if (nl > pos) {
							await this.emit({ kind: 'payload-chunk', chunk: chunk.subarray(pos, nl) });
						}
						await this.emit({ kind: 'payload-end' });
						pos = nl + 1;
						this.mode = 'item-header';
					}
					break;
				}
			}
		}
	}

	private currentMode(): Mode {
		return this.mode;
	}

	/**
	 * Signal EOF. Throws when a length-delimited payload is truncated; a
	 * final unframed item header line without a trailing newline yields an
	 * empty payload, matching the whole-body parser.
	 */
	async end(): Promise<void> {
		if (this.mode === 'done') return;

		switch (this.mode) {
			case 'envelope-header': {
				if ((this.line?.length ?? 0) === 0) {
					throw new EnvelopeFormatError('Invalid envelope: empty body');
				}
				await this.finishLine();
				this.mode = 'done';
				return;
			}
			case 'item-header': {
				const bytes = this.line;
				this.line = null;
				if (bytes === null || isBlank(bytes)) {
					this.mode = 'done';
					return;
				}
				// A complete item header line without its newline: parse it,
				// then EOF lands at the payload boundary.
				this.line = bytes;
				await this.finishLine();
				const mode = this.currentMode();
				if (mode === 'framed-payload' && this.framedRemaining > 0) {
					throw new EnvelopeFormatError('Invalid envelope: truncated item payload');
				}
				if (mode === 'unframed-payload') {
					// No length declared and no further bytes: empty payload.
					await this.emit({ kind: 'payload-end' });
				}
				this.mode = 'done';
				return;
			}
			case 'framed-payload': {
				throw new EnvelopeFormatError('Invalid envelope: truncated item payload');
			}
			case 'post-framed-newline': {
				// EOF exactly at a length-delimited payload boundary: valid.
				this.mode = 'done';
				return;
			}
			case 'unframed-payload': {
				await this.emit({ kind: 'payload-end' });
				this.mode = 'done';
				return;
			}
		}
	}
}
