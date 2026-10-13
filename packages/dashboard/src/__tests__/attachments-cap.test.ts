// Regression: decompressCapped must only report truncated=true when decoded
// content was actually dropped. fzstd invokes the ondata callback once more
// (empty/trailing buffer) after the final content chunk; the previous code
// set truncated=true unconditionally whenever the callback fired at an
// exhausted cap, so a preview whose decompressed size exactly equals the cap
// was flagged as truncated — text previews showed a misleading notice and
// exactly-cap-sized images were refused outright.
//
// The witness is a hand-built zstd frame (single-segment, one RLE block), so
// the regression needs no compressor dependency and no fast-check.
import { describe, expect, test } from 'vitest';
import { decompressCapped } from '../lib/attachments';

/** Single-segment zstd frame with one RLE block repeating `byte` `count` times. */
function rleFrame(count: number, byte: number): Uint8Array {
	const header = (count << 3) | (1 << 1) | 1; // RLE, last block
	return Uint8Array.from([
		0x28,
		0xb5,
		0x2f,
		0xfd, // magic
		0x20, // FHD: single segment, no FCS flag → 1-byte FCS
		count & 0xff, // frame content size == RLE count
		header & 0xff,
		(header >> 8) & 0xff,
		(header >> 16) & 0xff,
		byte,
	]);
}

describe('decompressCapped zstd cap boundary', () => {
	test('decoded size exactly equal to the cap is not truncated', async () => {
		const atCap = await decompressCapped(rleFrame(10, 0x41), 'zstd', 10);
		expect(atCap.bytes).toHaveLength(10);
		expect(atCap.bytes[0]).toBe(0x41);
		expect(atCap.truncated).toBe(false);
	});

	test('decoded size one over the cap is truncated at the cap', async () => {
		const overCap = await decompressCapped(rleFrame(11, 0x41), 'zstd', 10);
		expect(overCap.bytes).toHaveLength(10);
		expect(overCap.truncated).toBe(true);
	});

	test('decoded size one under the cap is not truncated', async () => {
		const underCap = await decompressCapped(rleFrame(9, 0x41), 'zstd', 10);
		expect(underCap.bytes).toHaveLength(9);
		expect(underCap.truncated).toBe(false);
	});
});
