import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	adminFetch,
	authFetch,
	createTestUser,
	getAdminPasskeySession,
	getAdminPasswordSession,
	passkeyLoginCeremony,
	registerPasskeyCeremony,
	type TestUser,
} from './utils';
import { VirtualAuthenticator } from './webauthn-helper';

const BASE = 'http://localhost';

/** Request sender with an optional bearer token (null = anonymous). */
function sendWith(token: string | null, path: string, init: RequestInit = {}): Promise<Response> {
	return SELF.fetch(path, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(init.headers || {}),
		},
	});
}

/** Representative routes across the whole admin surface. */
interface RouteCase {
	label: string;
	send: (token: string | null) => Promise<Response>;
	successStatus: number;
}

function adminRoutesMatrix(): RouteCase[] {
	return [
		{
			label: 'GET /api/admin/users',
			send: (token) => sendWith(token, `${BASE}/api/admin/users`),
			successStatus: 200,
		},
		{
			label: 'POST /api/admin/users',
			send: (token) =>
				sendWith(token, `${BASE}/api/admin/users`, {
					method: 'POST',
					body: JSON.stringify({
						name: 'Gate Matrix User',
						email: `gate-matrix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
						password: 'temppassword123',
					}),
				}),
			successStatus: 201,
		},
		{
			label: 'GET /api/admin/audit',
			send: (token) => sendWith(token, `${BASE}/api/admin/audit`),
			successStatus: 200,
		},
		{
			label: 'GET /api/admin/settings',
			send: (token) => sendWith(token, `${BASE}/api/admin/settings`),
			successStatus: 200,
		},
		{
			label: 'PUT /api/admin/settings',
			send: (token) =>
				sendWith(token, `${BASE}/api/admin/settings`, {
					method: 'PUT',
					body: JSON.stringify({ registrationOpen: true }),
				}),
			successStatus: 200,
		},
		{
			label: 'GET /api/admin/projects',
			send: (token) => sendWith(token, `${BASE}/api/admin/projects`),
			successStatus: 200,
		},
	];
}

describe('Admin Routes', () => {
	let memberUser: TestUser & { id: string };

	beforeAll(async () => {
		memberUser = await createTestUser({
			email: `admin-route-member-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Admin Route Member',
		});
	});

	describe('admin gate enforces passkey session on every admin route', () => {
		it('rejects anonymous requests with 401', async () => {
			for (const route of adminRoutesMatrix()) {
				const response = await route.send(null);
				expect(response.status, route.label).toBe(401);
				const data = (await response.json()) as { error: string };
				expect(data.error, route.label).toBe('unauthorized');
			}
		});

		it('rejects valid wst_ API tokens with 403 session_required (even for an admin)', async () => {
			// Mint a real API token from an admin's password session so the
			// rejection proves the raw-prefix check fires before the role or
			// passkey checks could matter.
			const passwordSession = await getAdminPasswordSession();
			const mint = await authFetch(passwordSession, `${BASE}/api/auth/tokens`, {
				method: 'POST',
				body: JSON.stringify({ name: 'gate-matrix' }),
			});
			expect(mint.status).toBe(200);
			const mintData = (await mint.json()) as { rawToken: string };

			for (const route of adminRoutesMatrix()) {
				const response = await route.send(mintData.rawToken);
				expect(response.status, route.label).toBe(403);
				const data = (await response.json()) as { error: string };
				expect(data.error, route.label).toBe('session_required');
			}
		});

		it('rejects member sessions with 403 forbidden', async () => {
			for (const route of adminRoutesMatrix()) {
				const response = await route.send(memberUser.token!);
				expect(response.status, route.label).toBe(403);
				const data = (await response.json()) as { error: string };
				expect(data.error, route.label).toBe('forbidden');
			}
		});

		it('rejects admin password sessions with 403 passkey_required', async () => {
			const passwordSession = await getAdminPasswordSession();
			for (const route of adminRoutesMatrix()) {
				const response = await route.send(passwordSession);
				expect(response.status, route.label).toBe(403);
				const data = (await response.json()) as { error: string };
				expect(data.error, route.label).toBe('passkey_required');
			}
		});

		it('admits admin passkey sessions to the endpoint success status', async () => {
			const session = await getAdminPasskeySession();
			for (const route of adminRoutesMatrix()) {
				const response = await route.send(session.token);
				expect(response.status, route.label).toBe(route.successStatus);
			}
		});

		it('authenticates mixed-case, whitespace-padded Bearer headers', async () => {
			const session = await getAdminPasskeySession();
			const response = await SELF.fetch(`${BASE}/api/admin/users`, {
				headers: { Authorization: `  bEaReR    ${session.token}  ` },
			});
			expect(response.status).toBe(200);
		});

		it('still answers OPTIONS with the bare 204 preflight', async () => {
			const response = await SELF.fetch(`${BASE}/api/admin/users`, { method: 'OPTIONS' });
			expect(response.status).toBe(204);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		});
	});

	describe('sessions record auth method', () => {
		it('password login mints a password-method session with additive fields', async () => {
			const user = await createTestUser({
				email: `pw-session-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Password Session User',
			});
			const response = await SELF.fetch(`${BASE}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: user.email, password: user.password }),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				authMethod?: string;
				mustChangePassword?: boolean;
				hasPasskey?: boolean;
			};
			expect(data.authMethod).toBe('password');
			expect(data.mustChangePassword).toBe(false);
			expect(typeof data.hasPasskey).toBe('boolean');

			// /me exposes the session's auth method too
			const me = await authFetch(user.token!, `${BASE}/api/auth/me`);
			expect(me.status).toBe(200);
			const meData = (await me.json()) as {
				session?: { authMethod?: string };
				mustChangePassword?: boolean;
			};
			expect(meData.session?.authMethod).toBe('password');
			expect(meData.mustChangePassword).toBe(false);
		});

		it('self-registration mints a password-method session', async () => {
			const response = await SELF.fetch(`${BASE}/api/auth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: `register-session-${Date.now()}@example.com`,
					password: 'testpassword123',
					name: 'Register Session User',
					setupToken: 'test-setup-token',
				}),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				authMethod?: string;
				mustChangePassword?: boolean;
			};
			expect(data.authMethod).toBe('password');
			expect(data.mustChangePassword).toBe(false);
		});

		it('passkey login mints a passkey-method session', async () => {
			const user = await createTestUser({
				email: `passkey-session-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Passkey Session User',
			});
			const authenticator = new VirtualAuthenticator();
			await authenticator.init();
			const register = await registerPasskeyCeremony(user.token!, authenticator);
			expect(register.status).toBe(200);

			const login = await passkeyLoginCeremony(authenticator);
			expect(login.verify.status).toBe(200);
			expect(login.data.authMethod).toBe('passkey');
			expect(login.data.token).toBeTruthy();

			// The minted session carries the method through validation
			const me = await authFetch(login.data.token!, `${BASE}/api/auth/me`);
			const meData = (await me.json()) as { session?: { authMethod?: string } };
			expect(meData.session?.authMethod).toBe('passkey');
		});

		it('registering a passkey does not upgrade a password session', async () => {
			// An admin in a password session registers a passkey: the strict
			// session gate still rejects admin routes until re-login via
			// passkey. (This is also the fail-closed proof for pre-migration
			// sessions, which carry the DEFAULT 'password' method.)
			const passwordSession = await getAdminPasswordSession();
			const authenticator = new VirtualAuthenticator();
			await authenticator.init();
			const register = await registerPasskeyCeremony(passwordSession, authenticator);
			expect(register.status).toBe(200);

			const blocked = await authFetch(passwordSession, `${BASE}/api/admin/users`);
			expect(blocked.status).toBe(403);
			const blockedData = (await blocked.json()) as { error: string };
			expect(blockedData.error).toBe('passkey_required');

			// Re-login via the passkey unlocks the admin surface
			const login = await passkeyLoginCeremony(authenticator);
			expect(login.verify.status).toBe(200);
			const allowed = await authFetch(login.data.token!, `${BASE}/api/admin/users`);
			expect(allowed.status).toBe(200);
		});
	});

	describe('GET /api/admin/users', () => {
		it('returns the admin user shape, newest first', async () => {
			const response = await adminFetch(`${BASE}/api/admin/users`);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				users: Array<{
					id: string;
					email: string;
					name: string;
					role: string;
					disabled: boolean;
					mustChangePassword: boolean;
					lastLoginAt: string | null;
					passkeyCount: number;
					membershipCount: number;
					createdAt: string;
				}>;
			};

			expect(data.users.length).toBeGreaterThanOrEqual(2);
			for (const user of data.users) {
				expect(user.id).toBeDefined();
				expect(user.email).toBeDefined();
				expect(user.name).toBeDefined();
				expect(user.role).toBeDefined();
				expect(typeof user.disabled).toBe('boolean');
				expect(typeof user.mustChangePassword).toBe('boolean');
				expect(typeof user.passkeyCount).toBe('number');
				expect(typeof user.membershipCount).toBe('number');
				expect(user.createdAt).toBeDefined();
			}

			const emails = data.users.map((u) => u.email);
			expect(emails).toContain(memberUser.email);

			// Newest first
			for (let i = 1; i < data.users.length; i++) {
				expect(data.users[i - 1].createdAt >= data.users[i].createdAt).toBe(true);
			}
		});
	});

	describe('GET /api/admin/users/:userId', () => {
		it('returns the user with memberships', async () => {
			const response = await adminFetch(`${BASE}/api/admin/users/${memberUser.id}`);
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				user: { id: string; email: string; membershipCount: number };
				memberships: Array<{ projectId: string; name: string; slug: string; role: string }>;
			};
			expect(data.user.id).toBe(memberUser.id);
			expect(data.user.email).toBe(memberUser.email);
			expect(Array.isArray(data.memberships)).toBe(true);
		});

		it('returns 404 for unknown users', async () => {
			const response = await adminFetch(
				`${BASE}/api/admin/users/00000000-0000-0000-0000-000000000000`,
			);
			expect(response.status).toBe(404);
		});
	});

	describe('settings', () => {
		it('reads and writes the registration toggle', async () => {
			const getBefore = await adminFetch(`${BASE}/api/admin/settings`);
			const before = (await getBefore.json()) as { settings: { registrationOpen: boolean } };

			const put = await adminFetch(`${BASE}/api/admin/settings`, {
				method: 'PUT',
				body: JSON.stringify({ registrationOpen: !before.settings.registrationOpen }),
			});
			expect(put.status).toBe(200);
			const afterPut = (await put.json()) as { settings: { registrationOpen: boolean } };
			expect(afterPut.settings.registrationOpen).toBe(!before.settings.registrationOpen);

			// Restore
			const restore = await adminFetch(`${BASE}/api/admin/settings`, {
				method: 'PUT',
				body: JSON.stringify({ registrationOpen: before.settings.registrationOpen }),
			});
			expect(restore.status).toBe(200);
		});

		it('rejects invalid bodies with 400', async () => {
			const response = await SELF.fetch(`${BASE}/api/admin/settings`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${(await getAdminPasskeySession()).token}`,
				},
				body: 'not json at all',
			});
			expect(response.status).toBe(400);
			const data = (await response.json()) as { error: string };
			expect(data.error).toBe('invalid_json');
		});
	});
});
