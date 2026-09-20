import { Decompress as ZstdDecompressor } from 'fzstd';

/**
 * Attachment preview support: classify stored attachments by filename,
 * fetch their bytes with dashboard auth, and — for recognizable types that
 * were compressed before upload (`events.jsonl.gz`, `config.json.zst`) —
 * decompress client-side. The server stores payloads verbatim and never
 * decodes, so the UI owns unrolling.
 */

export interface AttachmentMeta {
	id: string;
	eventId: string;
	filename: string;
	contentType: string;
	size: number;
	createdAt: string;
}

export type PreviewKind = 'text' | 'image' | 'unsupported';

export interface AttachmentClass {
	/** Effective type after stripping a `.gz`/`.zst` suffix. */
	kind: PreviewKind;
	/** Compression that must be undone before the bytes are usable. */
	compression: 'gzip' | 'zstd' | null;
	/** The effective filename (`events.jsonl.gz` → `events.jsonl`). */
	effectiveName: string;
	/** Extension of the effective name (`jsonl`), lowercase. */
	extension: string;
	mimeType: string;
}

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'md', 'json', 'jsonl', 'yaml', 'yml']);
const IMAGE_MIME = new Map<string, string>([
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
]);

/** Hard cap on bytes pulled into the tab for one preview. */
export const PREVIEW_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
/** Compressed/stored size beyond which we do not even fetch for preview. */
export const PREVIEW_MAX_STORED_BYTES = 8 * 1024 * 1024;
/**
 * Maximum zstd history window a preview may allocate. The decoder allocates
 * its window from the (attacker-controlled) frame header before producing
 * any output — up to ~2 GiB — so frames are pre-walked and refused above
 * this bound instead of relying on output capping.
 */
const PREVIEW_MAX_ZSTD_WINDOW = 8 * 1024 * 1024;

/** Signals "preview intentionally stopped at the decoded cap". */
class PreviewCapError extends Error {}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Walk every zstd frame header in `bytes` and return the largest declared
 * history window. Throws on malformed structure (fail-closed: previews are
 * optional, downloads remain available). Field order per the zstd spec and
 * fzstd's own rzfh: magic, FHD, [window descriptor], [dictionary id],
 * [frame content size, LITTLE-ENDIAN, +256 when FCS field is 2 bytes].
 */
function maxZstdWindow(bytes: Uint8Array): number {
	let offset = 0;
	let max = 0;
	while (offset < bytes.length) {
		if (bytes.length - offset < 6) throw new Error('truncated zstd frame header');
		if (
			bytes[offset] !== ZSTD_MAGIC[0] ||
			bytes[offset + 1] !== ZSTD_MAGIC[1] ||
			bytes[offset + 2] !== ZSTD_MAGIC[2] ||
			bytes[offset + 3] !== ZSTD_MAGIC[3]
		) {
			throw new Error('invalid zstd magic');
		}
		const fhd = bytes[offset + 4];
		if (fhd & 0x08) throw new Error('reserved zstd frame header bit set');
		const singleSegment = (fhd >> 5) & 1;
		const contentChecksum = (fhd >> 2) & 1;
		const dictFlag = fhd & 0x03;
		const fcsFlag = fhd >> 6;

		// The window descriptor sits DIRECTLY after the FHD (before dict id
		// and FCS) and only exists on non-single-segment frames.
		const windowDescriptor = singleSegment ? 0 : bytes[offset + 5];

		let cursor = offset + 5 + (singleSegment ? 0 : 1);
		cursor += dictFlag === 3 ? 4 : dictFlag;
		const fcsBytes = fcsFlag ? 1 << fcsFlag : singleSegment;
		if (fcsBytes > 0 && bytes.length - cursor < fcsBytes) {
			throw new Error('truncated zstd frame header');
		}
		let frameSize = 0;
		for (let i = 0; i < fcsBytes; i++) frameSize += bytes[cursor + i] * 2 ** (i * 8);
		if (fcsFlag === 1) frameSize += 256;
		cursor += fcsBytes;

		let window: number;
		if (singleSegment) {
			window = Math.max(frameSize, 8);
		} else {
			const base = 2 ** (10 + (windowDescriptor >> 3));
			window = base + (base >> 3) * (windowDescriptor & 7);
		}
		if (!Number.isSafeInteger(window) || window < 0) {
			throw new Error('unrepresentable zstd window');
		}
		// Inline bound: never keep walking (and never let a later malformed
		// frame mask the reason) once any frame declares an oversized window.
		if (window > PREVIEW_MAX_ZSTD_WINDOW) {
			throw new Error('zstd window exceeds the preview limit');
		}
		max = Math.max(max, window);

		// Skip blocks to find the next frame: 3-byte little-endian block
		// headers (last flag, type, size), RLE blocks carry a repeat count.
		for (;;) {
			if (bytes.length - cursor < 3) throw new Error('truncated zstd block header');
			const header = bytes[cursor] | (bytes[cursor + 1] << 8) | (bytes[cursor + 2] << 16);
			cursor += 3;
			const isLast = header & 1;
			const blockType = (header >> 1) & 0x03;
			const blockSize = header >>> 3;
			if (blockType === 1) {
				cursor += 1; // RLE: one literal byte, blockSize = repeat count
			} else if (blockType === 0 || blockType === 2) {
				cursor += blockSize;
			} else {
				throw new Error('reserved zstd block type');
			}
			if (cursor > bytes.length) throw new Error('truncated zstd block');
			if (isLast) break;
		}
		if (contentChecksum) {
			if (bytes.length - cursor < 4) throw new Error('truncated zstd checksum');
			cursor += 4;
		}
		offset = cursor;
	}
	return max;
}

export function classifyAttachment(filename: string): AttachmentClass {
	let effectiveName = filename;
	let compression: 'gzip' | 'zstd' | null = null;
	const dot = effectiveName.lastIndexOf('.');
	if (dot > 0) {
		const ext = effectiveName.slice(dot + 1).toLowerCase();
		if (ext === 'gz') compression = 'gzip';
		else if (ext === 'zst' || ext === 'zstd') compression = 'zstd';
		if (compression) effectiveName = effectiveName.slice(0, dot);
	}
	const extension = (effectiveName.slice(effectiveName.lastIndexOf('.') + 1) || '').toLowerCase();
	const imageMime = IMAGE_MIME.get(extension);
	const kind: PreviewKind = imageMime
		? 'image'
		: TEXT_EXTENSIONS.has(extension)
			? 'text'
			: 'unsupported';
	return {
		kind,
		compression,
		effectiveName,
		extension,
		mimeType: imageMime ?? 'text/plain; charset=utf-8',
	};
}

/** Fetch an authenticated binary blob (downloads and previews alike). */
export async function fetchAttachmentBytes(url: string): Promise<Uint8Array> {
	const token = localStorage.getItem('token');
	const response = await fetch(url, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Attachment fetch failed (${response.status}) ${text.slice(0, 120)}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Decompress with a decoded-size cap. Returns the bytes and whether the
 * cap truncated them (`truncated: true` → show a notice, offer download).
 * zstd frame size is not knowable upfront, so the cap is enforced while
 * decoding for both formats.
 */
export async function decompressCapped(
	bytes: Uint8Array,
	compression: 'gzip' | 'zstd',
	cap = PREVIEW_MAX_DECOMPRESSED_BYTES,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (compression === 'zstd') {
		// Pre-walk every frame header: the decoder allocates its history
		// window (attacker-controlled, up to ~2 GiB) before producing any
		// output, so oversized windows are refused up front.
		if (maxZstdWindow(bytes) > PREVIEW_MAX_ZSTD_WINDOW) {
			throw new Error('zstd window exceeds the preview limit');
		}
		// Abort decoding AT the cap by exception: ondata throwing unwinds
		// push synchronously, bounding decode work to the cap instead of
		// merely discarding over-cap output.
		const out: Uint8Array[] = [];
		let total = 0;
		let truncated = false;
		const decoder = new ZstdDecompressor((data: Uint8Array) => {
			if (total >= cap) {
				truncated = true;
				throw new PreviewCapError();
			}
			const take = Math.min(data.length, cap - total);
			out.push(data.subarray(0, take));
			total += take;
			if (take < data.length) truncated = true;
		});
		try {
			decoder.push(bytes, true);
		} catch (error) {
			if (!(error instanceof PreviewCapError)) throw error;
		}
		return { bytes: joinChunks(out, total), truncated };
	}
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	const reader = stream.getReader();
	const out: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > cap) {
			out.push(value.subarray(0, cap - total));
			total = cap;
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
		out.push(value);
		total += value.byteLength;
	}
	return { bytes: joinChunks(out, total), truncated };
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.length, total - offset);
		out.set(chunk.subarray(0, take), offset);
		offset += take;
		if (offset >= total) break;
	}
	return out;
}

/**
 * Load one attachment for preview: fetch → (maybe) decompress → decode.
 * `null` result means "preview not offered" (unsupported type or too large
 * stored); `truncated` flags the decompressed-cap notice.
 */
export async function loadAttachmentPreview(
	slug: string,
	attachment: AttachmentMeta,
): Promise<
	| { kind: 'text'; text: string; truncated: boolean; effectiveName: string }
	| { kind: 'image'; url: string; mimeType: string; effectiveName: string }
	| { kind: 'refused'; reason: string }
> {
	const cls = classifyAttachment(attachment.filename);
	if (cls.kind === 'unsupported') {
		return { kind: 'refused', reason: 'No inline preview for this file type — download instead' };
	}
	if (attachment.size > PREVIEW_MAX_STORED_BYTES) {
		return {
			kind: 'refused',
			reason: `Too large to preview (> ${formatBytes(PREVIEW_MAX_STORED_BYTES)} stored) — download instead`,
		};
	}

	const raw = await fetchAttachmentBytes(
		`/api/projects/${slug}/attachments/${encodeURIComponent(attachment.id)}`,
	);
	// The decoded cap applies to uncompressed payloads too: oversized text is
	// truncated, oversized images are refused — same as the compressed path.
	const bytes =
		cls.compression === 'gzip' || cls.compression === 'zstd'
			? await decompressCapped(raw, cls.compression)
			: raw.byteLength > PREVIEW_MAX_DECOMPRESSED_BYTES
				? {
						bytes: raw.subarray(0, PREVIEW_MAX_DECOMPRESSED_BYTES),
						truncated: true,
					}
				: { bytes: raw, truncated: false };

	if (cls.kind === 'image') {
		if (bytes.truncated) {
			return {
				kind: 'refused',
				reason: `Image exceeds the ${formatBytes(PREVIEW_MAX_DECOMPRESSED_BYTES)} preview cap — download instead`,
			};
		}
		const url = URL.createObjectURL(
			new Blob([bytes.bytes as unknown as BlobPart], { type: cls.mimeType }),
		);
		return { kind: 'image', url, mimeType: cls.mimeType, effectiveName: cls.effectiveName };
	}

	let text = new TextDecoder('utf-8').decode(bytes.bytes);
	// Pretty-print well-formed single-object JSON, bounded to the same cap
	if (cls.extension === 'json' && !bytes.truncated) {
		try {
			const formatted = JSON.stringify(JSON.parse(text), null, 2);
			if (formatted.length <= PREVIEW_MAX_DECOMPRESSED_BYTES) {
				text = formatted;
			}
		} catch {
			// leave raw
		}
	}
	return { kind: 'text', text, truncated: bytes.truncated, effectiveName: cls.effectiveName };
}

/** Trigger a browser download for an attachment (auth'd fetch → blob). */
export async function downloadAttachment(slug: string, attachment: AttachmentMeta): Promise<void> {
	const bytes = await fetchAttachmentBytes(
		`/api/projects/${slug}/attachments/${encodeURIComponent(attachment.id)}`,
	);
	const url = URL.createObjectURL(
		new Blob([bytes as unknown as BlobPart], { type: attachment.contentType }),
	);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = attachment.filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
