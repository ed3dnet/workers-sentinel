import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTestUser } from './utils';

describe('CORS policy', () => {
	it('does not grant cross-origin access to protected API routes', async () => {
		const preflight = await SELF.fetch('http://localhost/api/projects', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://evil.example',
				'Access-Control-Request-Method': 'GET',
				'Access-Control-Request-Headers': 'authorization',
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull();

		const get = await SELF.fetch('http://localhost/api/projects', {
			headers: { Origin: 'https://evil.example' },
		});
		expect(get.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('allows credentialed same-server requests without CORS interference', async () => {
		const user = await createTestUser({
			email: `cors-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'CORS User',
		});
		const response = await SELF.fetch('http://localhost/api/projects', {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		expect(response.ok).toBe(true);
	});

	it('serves permissive, credential-less CORS on ingestion endpoints for browser SDKs', async () => {
		const preflight = await SELF.fetch('http://localhost/api/some-project-id/envelope/', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://customer-app.example',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type,x-sentry-auth',
			},
		});
		expect(preflight.status).toBeLessThan(400);
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull();
	});
});
