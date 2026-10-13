// Regression: validateWebhookUrl's docstring promises rejection of any
// "loopback/link-local/private literal" hostname, but the deny list missed
// four IPv6 forms — IPv4-mapped loopback/private (`[::ffff:127.0.0.1]`,
// `[::ffff:10.0.0.1]`), the unspecified address (`[::]`), and IPv6
// link-local (`[fe80::1]`) all passed validation. Production Workers egress
// cannot reach those ranges, but local dev under workerd can, and webhook
// delivery there would call straight back into the local stack.
//
// Pure-module regression (no HTTP, no fast-check): the fixed forms are
// rejected, a mapped PUBLIC IPv4 address still passes, and every previously
// documented rejection keeps holding.
import { describe, expect, test } from 'vitest';
import { validateWebhookUrl } from '../src/lib/webhook';

describe('validateWebhookUrl IPv6 literal denial', () => {
	test('rejects IPv4-mapped, unspecified, and link-local IPv6 literals', () => {
		for (const url of [
			'https://[::ffff:127.0.0.1]/hook',
			'https://[::ffff:10.0.0.1]/hook',
			'https://[::ffff:192.168.1.1]/hook',
			'https://[::127.0.0.1]/hook', // deprecated IPv4-compatible form
			'https://[::]/hook',
			'https://[fe80::1]/hook',
			'https://[fe90::]/hook',
			'https://[febf::1]/hook',
		]) {
			expect(validateWebhookUrl(url).ok, url).toBe(false);
		}
	});

	test('hex-form IPv4-mapped addresses are denied (not cheaply verifiable)', () => {
		// ::ffff:7f00:1 is 127.0.0.1 in hex-mapped form.
		expect(validateWebhookUrl('https://[::ffff:7f00:1]/hook').ok).toBe(false);
	});

	test('mapped PUBLIC IPv4 and ordinary public IPv6 still pass', () => {
		expect(validateWebhookUrl('https://[::ffff:8.8.8.8]/hook').ok).toBe(true);
		expect(validateWebhookUrl('https://[2606:4700::6810:84e5]/hook').ok).toBe(true);
		expect(validateWebhookUrl('https://[2001:4860:4860::8888]/hook').ok).toBe(true);
	});

	test('previously documented rejections keep holding', () => {
		for (const url of [
			'http://example.com/hook',
			'https://user:pass@example.com/hook',
			'https://localhost/hook',
			'https://127.0.0.1/hook',
			'https://10.1.2.3/hook',
			'https://192.168.1.1/hook',
			'https://172.16.0.1/hook',
			'https://169.254.1.1/hook',
			'https://[::1]/hook',
			'https://[fd12:3456:789a::1]/hook',
			'https://[fc00::1]/hook',
		]) {
			expect(validateWebhookUrl(url).ok, url).toBe(false);
		}
		// 172.32.0.1 is outside 172.16-31 and stays allowed.
		expect(validateWebhookUrl('https://172.32.0.1/hook').ok).toBe(true);
	});
});
