import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { workersSentinel } from '../src/index';

describe('dashboard deployment configuration', () => {
	it('exposes only the public feedback DSN without authentication or caching', async () => {
		const response = await SELF.fetch('http://localhost/api/dashboard-config');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(await response.json()).toEqual({ feedbackDsn: env.FEEDBACK_DSN });
	});
	it('defaults to disabled and trims configured DSNs', async () => {
		const app = workersSentinel();
		const off = await app.fetch(new Request('http://localhost/api/dashboard-config'), {
			...env,
			FEEDBACK_DSN: undefined,
		});
		expect(await off.json()).toEqual({ feedbackDsn: null });
		const enabled = await app.fetch(new Request('http://localhost/api/dashboard-config'), {
			...env,
			FEEDBACK_DSN: ' https://key@sentinel.test/project ',
		});
		expect(await enabled.json()).toEqual({ feedbackDsn: 'https://key@sentinel.test/project' });
	});
});
