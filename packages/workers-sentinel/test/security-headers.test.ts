import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('security headers', () => {
	it('sets hardening headers on API responses', async () => {
		const response = await SELF.fetch('http://localhost/api/health');
		expect(response.ok).toBe(true);
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Strict-Transport-Security')).toContain('max-age');
	});

	it('serves HTML responses with a strict CSP', async () => {
		const response = await SELF.fetch('http://localhost/');
		const contentType = response.headers.get('Content-Type') ?? '';
		if (contentType.includes('text/html')) {
			const csp = response.headers.get('Content-Security-Policy') ?? '';
			expect(csp).toContain("script-src 'self'");
			expect(csp).toContain("frame-ancestors 'none'");
			expect(csp).not.toContain('unsafe-eval');
		}
	});
});
