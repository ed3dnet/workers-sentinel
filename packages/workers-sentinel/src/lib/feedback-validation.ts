export const FEEDBACK_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 1536 * 1024;
export const FEEDBACK_MAX_METADATA_BYTES = 12 * 1024;

const ALLOWED_RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Check only the declared type and the corresponding container signature.
 * This is not a decoder: structural validity and decoded-pixel limits are
 * intentionally outside the feedback upload contract.
 */
export function hasAllowedRasterSignature(type: string, bytes: Uint8Array): boolean {
	if (!ALLOWED_RASTER_TYPES.has(type)) return false;
	if (type === 'image/png') {
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		return (
			bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
		);
	}
	if (type === 'image/jpeg') {
		return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	}
	return (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
	);
}

export function isAllowedRasterType(type: string): boolean {
	return ALLOWED_RASTER_TYPES.has(type);
}
