// Regression: sanitizeEvent's contract is that client-controlled timestamps
// are "validated or replaced", but only strings were handled — a numeric
// timestamp (legal in the Sentry envelope spec: unix epoch seconds/floats)
// passed through unvalidated into the TEXT events.timestamp column (stored
// as e.g. '1234', sorting oldest in timestamp DESC listings) while the
// stored event JSON echoed the raw number. Non-string timestamps are now
// replaced with the receipt time under the same policy as out-of-window
// strings. Pure-module regression, no fast-check.
import { describe, expect, test } from 'vitest';
import { sanitizeEvent } from '../src/lib/envelope-parser';
import type { SentryEvent } from '../src/types';

describe('sanitizeEvent: non-string timestamps are replaced with receipt time', () => {
	test('numeric timestamps become ISO strings near now', () => {
		for (const bad of [1234, 1760000000, 1760000000.5, -1]) {
			const before = Date.now();
			const out = sanitizeEvent({ timestamp: bad } as SentryEvent);
			expect(typeof out.timestamp, `timestamp ${bad}`).toBe('string');
			const parsed = new Date(out.timestamp as string).getTime();
			expect(Math.abs(parsed - before)).toBeLessThanOrEqual(60_000);
		}
	});

	test('non-number non-string timestamps are replaced too', () => {
		for (const bad of [true, false, {}, [], NaN, Infinity]) {
			const out = sanitizeEvent({ timestamp: bad } as SentryEvent);
			expect(typeof out.timestamp, `timestamp ${String(bad)}`).toBe('string');
			expect(Number.isNaN(new Date(out.timestamp as string).getTime())).toBe(false);
		}
	});

	test('string timestamps keep their existing behavior', () => {
		const valid = new Date(Date.now() - 60_000).toISOString();
		expect(sanitizeEvent({ timestamp: valid } as SentryEvent).timestamp).toBe(valid);
		const outOfWindow = '1999-01-01T00:00:00.000Z';
		const out = sanitizeEvent({ timestamp: outOfWindow } as SentryEvent);
		expect(out.timestamp).not.toBe(outOfWindow);
		expect(Number.isNaN(new Date(out.timestamp as string).getTime())).toBe(false);
	});
});
