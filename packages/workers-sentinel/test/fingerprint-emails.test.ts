// Regression: normalizeMessage's email rule had two first-character
// dependencies. (1) Its leading \b made the match start at the first word
// character, so a local part beginning with a non-word character the address
// grammar allows (%a@corp.example) kept its prefix behind unnormalized.
// (2) It ran AFTER the bare-number rule, so a digit-heavy local part
// (408395@corp.example) was half-consumed as <num>@corp.example. Either way,
// two occurrences of the same logical error with differently-shaped emails
// landed in different issues. The email rule now runs first (after UUIDs)
// with a lookbehind that tolerates any grammar-legal first character, so any
// syntactically matching address normalizes to the same <email> token.
// Pure-module regression, no fast-check.
import { describe, expect, test } from 'vitest';
import { generateFingerprint } from '../src/lib/fingerprint';
import type { SentryEvent } from '../src/types';

const fp = (message: string) => generateFingerprint({ message } as SentryEvent);

describe('normalizeMessage: any grammar-legal email normalizes to <email>', () => {
	test('digit-heavy and non-word-prefixed local parts group with ordinary ones', () => {
		const base = fp('login failed for jane@corp.example');
		expect(fp('login failed for 408395@corp.example')).toBe(base);
		expect(fp('login failed for 123456789012345678901234@corp.example')).toBe(base);
		expect(fp('login failed for %agent@corp.example')).toBe(base);
		expect(fp('login failed for .quoted@corp.example')).toBe(base);
		expect(fp('login failed for jane+triage@corp.example')).toBe(base);
		expect(fp('login failed for 408395@other.example')).toBe(base);
	});

	test('different domains still group (the address is the variable part)', () => {
		expect(fp('login failed for jane@corp.example')).toBe(fp('login failed for bob@other.example'));
	});

	test('numbers outside emails still follow the number rules', () => {
		expect(fp('timeout after 12345678 ms')).toBe(fp('timeout after 98765432 ms'));
		expect(fp('request failed with 404')).not.toBe(fp('request failed with 500'));
	});
});
