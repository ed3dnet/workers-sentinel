import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTestUser, waitFor } from './utils';

describe('session hardening', () => {
	it('logout-all invalidates every session for the user', async () => {
		const user = await createTestUser({
			email: `logout-all-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Logout All',
		});

		// Second session for the same user
		const login = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: user.password }),
		});
		expect(login.ok).toBe(true);
		const { token: token2 } = (await login.json()) as { token: string };

		// Both tokens work
		for (const token of [user.token, token2]) {
			const me = await SELF.fetch('http://localhost/api/auth/me', {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(me.ok).toBe(true);
		}

		const logoutAll = await SELF.fetch('http://localhost/api/auth/logout-all', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token2}` },
		});
		expect(logoutAll.ok).toBe(true);

		// Both tokens are now dead
		for (const token of [user.token, token2]) {
			const me = await SELF.fetch('http://localhost/api/auth/me', {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(me.status).toBe(401);
		}
	});

	it('rejects API tokens on logout-all', async () => {
		const user = await createTestUser({
			email: `loa-token-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'LOA Token',
		});
		const create = await SELF.fetch('http://localhost/api/auth/tokens', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${user.token}`,
			},
			body: JSON.stringify({ name: 'test' }),
		});
		const { rawToken } = (await create.json()) as { rawToken: string };

		const logoutAll = await SELF.fetch('http://localhost/api/auth/logout-all', {
			method: 'POST',
			headers: { Authorization: `Bearer ${rawToken}` },
		});
		expect(logoutAll.status).toBe(401);
	});

	it('prunes old sessions beyond 20 per user', { timeout: 60000 }, async () => {
		const email = `prune-${Date.now()}@example.com`;
		const password = 'testpassword123';
		const tokens: string[] = [];
		for (let i = 0; i < 22; i++) {
			const login = await SELF.fetch('http://localhost/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
			});
			if (login.status === 401 && i === 0) {
				// first login must register
				await createTestUser({ email, password, name: 'Prune User' });
				continue;
			}
			const { token } = (await login.json()) as { token: string };
			tokens.push(token);
		}
		// ensure we got at least 21 sessions
		await waitFor(async () => {
			const me = await SELF.fetch('http://localhost/api/auth/me', {
				headers: { Authorization: `Bearer ${tokens[tokens.length - 1]}` },
			});
			return me.ok;
		});
		expect(tokens.length).toBeGreaterThanOrEqual(21);

		const oldest = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `Bearer ${tokens[0]}` },
		});
		expect(oldest.status).toBe(401);
		const newest = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `Bearer ${tokens[tokens.length - 1]}` },
		});
		expect(newest.ok).toBe(true);
	});

	it('accepts case-insensitive bearer scheme with surrounding whitespace', async () => {
		const user = await createTestUser({
			email: `case-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Case User',
		});
		const me = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `  bEaReR  ${user.token} ` },
		});
		expect(me.ok).toBe(true);
	});
});
