import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTestUser } from './utils';

async function adminSetDisabled(userId: string, disabled: boolean): Promise<void> {
	const id = env.AUTH_STATE.idFromName('global');
	await env.AUTH_STATE.get(id).fetch(
		new Request('http://internal/admin/set-user-disabled', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ requestingUserRole: 'admin', userId, disabled }),
		}),
	);
}

describe('account lifecycle', () => {
	it('changes the password with re-authentication and revokes sessions', async () => {
		const user = await createTestUser({
			email: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Password User',
		});

		const wrong = await SELF.fetch('http://localhost/api/auth/change-password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
			body: JSON.stringify({ currentPassword: 'not-the-password', newPassword: 'newpassword456' }),
		});
		expect(wrong.status).toBe(401);

		const right = await SELF.fetch('http://localhost/api/auth/change-password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
			body: JSON.stringify({ currentPassword: 'testpassword123', newPassword: 'newpassword456' }),
		});
		expect(right.status).toBe(200);

		// Old session is revoked
		const me = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		expect(me.status).toBe(401);

		// Old password no longer works; new one does
		const oldLogin = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: 'testpassword123' }),
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: 'newpassword456' }),
		});
		expect(newLogin.status).toBe(200);
	});

	it('disabling a user blocks login and kills live sessions', async () => {
		const user = await createTestUser({
			email: `dis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Disable User',
		});

		await adminSetDisabled(user.id, true);

		// Existing session dead
		const me = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		expect(me.status).toBe(401);

		// Login returns the uniform invalid-credentials error (no disable oracle)
		const login = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: 'testpassword123' }),
		});
		expect(login.status).toBe(401);
		const data = (await login.json()) as { error: string };
		expect(data.error).toBe('invalid_credentials');

		// Re-enable restores access
		await adminSetDisabled(user.id, false);
		const relogin = await SELF.fetch('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: user.email, password: 'testpassword123' }),
		});
		expect(relogin.status).toBe(200);
	});

	it('non-admin cannot disable users through the API route', async () => {
		const user = await createTestUser({
			email: `noroute-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'No Route User',
		});
		const response = await SELF.fetch(`http://localhost/api/admin/users/${user.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
			body: JSON.stringify({ disabled: true }),
		});
		expect(response.status).toBe(403);
	});
});
