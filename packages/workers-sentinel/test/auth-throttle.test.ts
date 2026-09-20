import { env, SELF } from 'cloudflare:test';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestUser } from './utils';

async function setRegistrationOpen(open: boolean): Promise<void> {
	const id = env.AUTH_STATE.idFromName('global');
	await env.AUTH_STATE.get(id).fetch(
		new Request('http://internal/set-settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ requestingUserRole: 'admin', registrationOpen: open }),
		}),
	);
}

afterAll(async () => {
	await setRegistrationOpen(true);
});

describe('login throttling', () => {
	it('locks the account after 5 failed attempts, even with the correct password', async () => {
		const user = await createTestUser({
			email: `lock-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Lock User',
		});

		for (let i = 0; i < 5; i++) {
			const response = await SELF.fetch('http://localhost/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: user.email, password: 'wrong-password' }),
			});
			expect(response.status).toBe(401);
		}

		const locked = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: user.password }),
		});
		expect(locked.status).toBe(429);
		const body = (await locked.json()) as { error: string; retryAfter?: number };
		expect(body.error).toBe('too_many_attempts');
		expect(typeof body.retryAfter).toBe('number');
	});

	it('clears the failure counter on successful login', { timeout: 60_000 }, async () => {
		const user = await createTestUser({
			email: `reset-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Reset User',
		});

		for (let i = 0; i < 4; i++) {
			await SELF.fetch('http://localhost/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: user.email, password: 'wrong-password' }),
			});
		}
		const ok = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: user.password }),
		});
		expect(ok.status).toBe(200);

		// Counter was reset: four more failures do not lock
		for (let i = 0; i < 4; i++) {
			const response = await SELF.fetch('http://localhost/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: user.email, password: 'wrong-password' }),
			});
			expect(response.status).toBe(401);
		}
	});

	it('counts unknown-account attempts under the same throttle key', async () => {
		const email = `ghost-${Date.now()}@example.com`;
		for (let i = 0; i < 5; i++) {
			const response = await SELF.fetch('http://localhost/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password: 'whatever123' }),
			});
			expect(response.status).toBe(401);
		}
		const locked = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password: 'whatever123' }),
		});
		expect(locked.status).toBe(429);
	});
});

describe('registration validation and controls', () => {
	it('rejects invalid emails and short passwords', async () => {
		const cases = [
			{ email: 'not-an-email', password: 'longenough123', name: 'X' },
			{ email: `v-${Date.now()}@example.com`, password: 'short', name: 'X' },
		];
		for (const body of cases) {
			const response = await SELF.fetch('http://localhost/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect([400, 403]).toContain(response.status);
			if (response.status === 400) {
				const data = (await response.json()) as { error: string };
				expect(['invalid_email', 'invalid_password']).toContain(data.error);
			}
		}
	});

	it('normalizes email case so mixed-case duplicates collide', async () => {
		const user = await createTestUser({
			email: `norm-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Norm User',
		});
		const upper = user.email.toUpperCase();
		const response = await SELF.fetch('http://localhost/api/auth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: upper, password: 'testpassword123', name: 'Dup' }),
		});
		expect(response.status).toBe(409);
	});

	it('blocks registration when the server setting is closed and reopens it after', async () => {
		await setRegistrationOpen(false);
		try {
			const response = await SELF.fetch('http://localhost/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: `closed-${Date.now()}@example.com`,
					password: 'testpassword123',
					name: 'Closed User',
					setupToken: 'test-setup-token',
				}),
			});
			expect(response.status).toBe(403);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe('registration_disabled');
		} finally {
			await setRegistrationOpen(true);
		}

		const reopened = await SELF.fetch('http://localhost/api/auth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: `reopened-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Reopened User',
			}),
		});
		expect(reopened.status).toBe(200);
	});

	it('non-admin cannot change settings via the API route', async () => {
		const user = await createTestUser({
			email: `noset-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'No Set User',
		});
		const response = await SELF.fetch('http://localhost/api/admin/settings', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
			body: JSON.stringify({ registrationOpen: false }),
		});
		expect(response.status).toBe(403);
	});
});
