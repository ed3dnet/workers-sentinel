import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password';

// biome-ignore lint: helper duplicated from password.ts intentionally for test independence
const legacySha256 = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

describe('password hashing (argon2id, workerd-compatible)', () => {
	it('hashes and verifies roundtrip in PHC format', () => {
		const start = Date.now();
		const hash = hashPassword('correct horse battery staple');
		expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
		expect(verifyPassword('correct horse battery staple', hash)).toEqual({
			ok: true,
			needsRehash: false,
		});
		expect(verifyPassword('wrong password', hash).ok).toBe(false);
		const elapsed = Date.now() - start;
		// Two argon2 computations (hash + verify) — keep an eye on CPU cost
		expect(elapsed).toBeLessThan(10000);
	});

	it('generates unique salts per hash', () => {
		const a = hashPassword('same password');
		const b = hashPassword('same password');
		expect(a).not.toEqual(b);
		expect(verifyPassword('same password', a).ok).toBe(true);
		expect(verifyPassword('same password', b).ok).toBe(true);
	});

	it('verifies legacy unsalted SHA-256 hashes and flags rehash', () => {
		const legacy = legacySha256('old-password');
		const result = verifyPassword('old-password', legacy);
		expect(result).toEqual({ ok: true, needsRehash: true });
		expect(verifyPassword('other-password', legacy).ok).toBe(false);
	});

	it('rejects malformed stored hashes without throwing', () => {
		expect(verifyPassword('x', 'not-a-hash').ok).toBe(false);
		expect(verifyPassword('x', '$argon2id$v=19$m=999999999,t=99,p=99$abc$def').ok).toBe(false);
		expect(verifyPassword('x', '').ok).toBe(false);
	});
});
