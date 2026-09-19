import { argon2id } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1).
// Pure-JS (no WASM) so it runs under the Workers embedder, which disallows
// dynamic WebAssembly compilation. Login/registration are rare operations, so
// the CPU cost is acceptable; tune via env overrides only with care.
export const ARGON2_PARAMS = { t: 2, m: 19456, p: 1, dkLen: 32 } as const;
const SALT_BYTES = 16;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
		out += B64[b0 >> 2];
		out += B64[((b0 & 3) << 4) | (b1 >> 4)];
		out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
		out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
	}
	// PHC strings use unpadded base64
	return out.replace(/=+$/, '');
}

function b64decode(text: string): Uint8Array {
	const clean = text.replace(/=+$/, '');
	const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let acc = 0;
	let bits = 0;
	let index = 0;
	for (const char of clean) {
		const value = B64.indexOf(char);
		if (value === -1) throw new Error('invalid base64 in hash');
		acc = (acc << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[index++] = (acc >> bits) & 0xff;
		}
	}
	return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

/** Hash a password with Argon2id; returns a PHC-format encoded string. */
export function hashPassword(password: string): string {
	const salt = randomBytes(SALT_BYTES);
	const hash = argon2id(utf8ToBytes(password), salt, ARGON2_PARAMS);
	return `$argon2id$v=19$m=${ARGON2_PARAMS.m},t=${ARGON2_PARAMS.t},p=${ARGON2_PARAMS.p}$${b64encode(salt)}$${b64encode(hash)}`;
}

export interface VerifyResult {
	ok: boolean;
	/** True when the stored hash was legacy single-pass SHA-256 and the caller should rehash with argon2id. */
	needsRehash: boolean;
}

/**
 * Verify a password against a stored hash. Supports current argon2id (PHC
 * format) and legacy unsalted single-pass SHA-256 (plain 64-hex, from
 * workers-sentinel <= 0.2.0). Legacy matches set needsRehash so callers can
 * upgrade the stored hash on successful login.
 */
export function verifyPassword(password: string, stored: string): VerifyResult {
	if (/^[0-9a-f]{64}$/i.test(stored)) {
		const legacy = bytesToHex(sha256(utf8ToBytes(password)));
		// Constant-time compare of hex strings of equal length
		let diff = 0;
		for (let i = 0; i < legacy.length; i++) {
			diff |= legacy.charCodeAt(i) ^ stored.toLowerCase().charCodeAt(i);
		}
		return { ok: diff === 0, needsRehash: true };
	}
	const match =
		/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
	if (!match) return { ok: false, needsRehash: false };
	const [, m, t, p, saltB64, hashB64] = match;
	const params = { m: Number(m), t: Number(t), p: Number(p), dkLen: b64decode(hashB64).length };
	if (
		params.m < 8 ||
		params.m > 1048576 ||
		params.t < 1 ||
		params.t > 16 ||
		params.p < 1 ||
		params.p > 4
	) {
		return { ok: false, needsRehash: false };
	}
	try {
		const computed = argon2id(utf8ToBytes(password), b64decode(saltB64), params);
		return {
			ok: constantTimeEqual(computed, b64decode(hashB64)),
			needsRehash: params.m !== ARGON2_PARAMS.m || params.t !== ARGON2_PARAMS.t,
		};
	} catch {
		return { ok: false, needsRehash: false };
	}
}

/** Hash high-entropy random tokens (sessions, API keys) for at-rest storage. */
export function hashToken(token: string): string {
	return bytesToHex(sha256(utf8ToBytes(token)));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
