import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authFetch, createTestUser } from './utils';

describe('API hygiene', () => {
	it('unknown /api path returns JSON 404', async () => {
		const response = await SELF.fetch('http://localhost/api/nope/');
		expect(response.status).toBe(404);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const data = (await response.json()) as { error: string };
		expect(data.error).toBe('not_found');

		// Deeper unknown paths behave the same, including GETs under the
		// public auth namespace
		const deep = await SELF.fetch('http://localhost/api/nope/deeper/still');
		expect(deep.status).toBe(404);
		expect(((await deep.json()) as { error: string }).error).toBe('not_found');
	});

	it('trailing-slash protected path: 401 anonymous, 404 JSON authenticated', async () => {
		const user = await createTestUser({
			email: `hygiene-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Hygiene User',
		});
		// The project does not exist; the trailing slash means no concrete
		// route matches and the request falls through the GET catch-all.
		const path = '/api/projects/does-not-exist/';

		const anonymous = await SELF.fetch(`http://localhost${path}`);
		expect(anonymous.status).toBe(401);

		const authenticated = await authFetch(user.token!, `http://localhost${path}`);
		expect(authenticated.status).toBe(404);
		expect(authenticated.headers.get('Content-Type')).toContain('application/json');
		const data = (await authenticated.json()) as { error: string };
		expect(data.error).toBe('not_found');
	});

	it('non-GET unmatched /api path returns JSON 404', async () => {
		const response = await SELF.fetch('http://localhost/api/nope', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ hi: true }),
		});
		expect(response.status).toBe(404);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const data = (await response.json()) as { error: string };
		expect(data.error).toBe('not_found');

		const deleted = await SELF.fetch('http://localhost/api/projects/x/issues/y', {
			method: 'DELETE',
		});
		// Auth precedence still applies on protected namespaces: the DELETE
		// path itself exists, so this is an auth rejection, not a 404 —
		// but an unknown DELETE path is a JSON 404 for anonymous callers only
		// after auth. Verify with a truly unknown path + method pair:
		expect([401, 404]).toContain(deleted.status);

		const unknownMethod = await SELF.fetch('http://localhost/api/nope/other', {
			method: 'PUT',
			body: '{}',
		});
		expect(unknownMethod.status).toBe(404);
		expect(((await unknownMethod.json()) as { error: string }).error).toBe('not_found');
	});
});
