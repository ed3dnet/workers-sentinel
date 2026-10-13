// Regression: normalizeMessage's hex-id rule `[0-9a-f]{24,}` also matched
// pure-decimal runs (decimal digits are hex characters), so an embedded
// number of ≥24 digits normalized to `<id>` while 6–23-digit numbers became
// `<num>`. The same error template split into different issues when its
// number crossed the 24-digit boundary — realistic via BigInt error
// messages, where JS prints full decimal values (39 digits for a 128-bit
// int). The hex-id rule now requires at least one a-f letter; pure-decimal
// runs always take the `<num>` path. Pure-module regression, no fast-check.
import { describe, expect, test } from 'vitest';
import { generateFingerprint } from '../src/lib/fingerprint';
import type { SentryEvent } from '../src/types';

const fp = (message: string) => generateFingerprint({ message } as SentryEvent);

describe('normalizeMessage: long decimal numbers normalize like any number', () => {
	test('numbers straddling the 24-digit boundary group together', () => {
		expect(fp('convert 123456789012345678901234 failed')).toBe(fp('convert 123456789 failed'));
		expect(fp('Cannot convert 340282366920938463463374607431768211456 to number')).toBe(
			fp('Cannot convert 123456789 to number'),
		);
	});

	test('true hex ids of ≥24 chars still collapse to the same token', () => {
		expect(fp('object 0123456789abcdef01234567 missing')).toBe(
			fp('object fedcba9876543210fedcba98 missing'),
		);
	});

	test('short error codes are still preserved verbatim', () => {
		expect(fp('request failed with 404')).toBe(fp('request failed with 404'));
		expect(fp('request failed with 404')).not.toBe(fp('request failed with 500'));
	});
});
