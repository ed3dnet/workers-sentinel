import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	adminFetch,
	authFetch,
	createTestUser,
	passkeyLoginCeremony,
	registerPasskeyCeremony,
} from './utils';
import { VirtualAuthenticator } from './webauthn-helper';

const BASE = 'http://localhost';

async function adminSetDisabled(userId: string, disabled: boolean): Promise<void> {
	const id = env.AUTH_STATE.idFromName('global');
	await env.AUTH_STATE.get(id).fetch(
		new Request('http://internal/admin/update-user', {
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

	it('admin disables a user through the gated route with a passkey session', async () => {
		const user = await createTestUser({
			email: `route-dis-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Route Disable User',
		});

		const disable = await adminFetch(`${BASE}/api/admin/users/${user.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ disabled: true }),
		});
		expect(disable.status).toBe(200);
		const data = (await disable.json()) as { user: { disabled: boolean } };
		expect(data.user.disabled).toBe(true);

		// Existing session dead
		const me = await SELF.fetch('http://localhost/api/auth/me', {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		expect(me.status).toBe(401);

		const enable = await adminFetch(`${BASE}/api/admin/users/${user.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ disabled: false }),
		});
		expect(enable.status).toBe(200);
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

// ---------------------------------------------------------------------------
// Self-service profile update (PATCH /api/auth/profile)
// ---------------------------------------------------------------------------

interface WireUser {
	id: string;
	email: string;
	name: string;
	role: string;
	createdAt: string;
	updatedAt: string;
}

interface AuditEntry {
	id: string;
	actorEmail: string;
	actorName: string;
	action: string;
	targetType: string;
	targetId: string | null;
	targetLabel: string | null;
	details: Record<string, unknown> | null;
	createdAt: string;
}

function uniqueEmail(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function patchProfile(token: string, body: unknown): Promise<Response> {
	return SELF.fetch(`${BASE}/api/auth/profile`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
}

async function passwordLogin(email: string, password: string): Promise<Response> {
	return SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
}

/** The caller's /api/auth/me user (asserts the session is live). */
async function meUser(token: string): Promise<WireUser> {
	const response = await SELF.fetch(`${BASE}/api/auth/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { user: WireUser }).user;
}

/** All audit rows targeting the user (keyset walk, newest first). */
async function auditFor(targetId: string): Promise<AuditEntry[]> {
	const entries: AuditEntry[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 50; page++) {
		const response = await adminFetch(
			`${BASE}/api/admin/audit?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
		);
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			entries: AuditEntry[];
			nextCursor?: string;
		};
		entries.push(...data.entries);
		if (!data.nextCursor) return entries.filter((entry) => entry.targetId === targetId);
		cursor = data.nextCursor;
	}
	throw new Error('Audit log pagination did not terminate within 50 pages');
}

describe('self-service profile update', () => {
	it(
		'changes name and email; new email signs in, old does not, sessions survive',
		{ timeout: 60000 },
		async () => {
			const user = await createTestUser({
				email: uniqueEmail('profile'),
				password: 'testpassword123',
				name: 'Profile User',
			});
			const newEmail = uniqueEmail('profile-renamed');

			const update = await patchProfile(user.token!, {
				name: 'Renamed User',
				email: newEmail,
			});
			expect(update.status).toBe(200);
			const data = (await update.json()) as { user: WireUser };
			expect(data.user.id).toBe(user.id);
			expect(data.user.name).toBe('Renamed User');
			expect(data.user.email).toBe(newEmail);

			// The pre-change session is still valid (email is not a credential)
			// and /api/auth/me reflects the new values
			const me = await meUser(user.token!);
			expect(me.name).toBe('Renamed User');
			expect(me.email).toBe(newEmail);

			// New email + same password signs in; the old one no longer does
			const newLogin = await passwordLogin(newEmail, 'testpassword123');
			expect(newLogin.status).toBe(200);
			const oldLogin = await passwordLogin(user.email, 'testpassword123');
			expect(oldLogin.status).toBe(401);

			// A passkey-minted session can update too (no authMethod gate)
			const passkeyUser = await createTestUser({
				email: uniqueEmail('profile-passkey'),
				password: 'testpassword123',
				name: 'Passkey Profile User',
			});
			const authenticator = new VirtualAuthenticator();
			await authenticator.init();
			const register = await registerPasskeyCeremony(passkeyUser.token!, authenticator);
			expect(register.status).toBe(200);
			const login = await passkeyLoginCeremony(authenticator);
			expect(login.verify.status).toBe(200);
			expect(login.data.authMethod).toBe('passkey');

			const passkeyUpdate = await patchProfile(login.data.token!, {
				name: 'Passkey Renamed',
			});
			expect(passkeyUpdate.status).toBe(200);
			const passkeyData = (await passkeyUpdate.json()) as { user: WireUser };
			expect(passkeyData.user.name).toBe('Passkey Renamed');
		},
	);

	it(
		'rejects API tokens, anonymous requests, and flagged sessions',
		{ timeout: 60000 },
		async () => {
			const user = await createTestUser({
				email: uniqueEmail('profile-gate'),
				password: 'testpassword123',
				name: 'Gate User',
			});

			// Anonymous → 401
			const anonymous = await SELF.fetch(`${BASE}/api/auth/profile`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Anonymous' }),
			});
			expect(anonymous.status).toBe(401);

			// API token → 403 session_required (minted from a valid session)
			const mint = await authFetch(user.token!, `${BASE}/api/auth/tokens`, {
				method: 'POST',
				body: JSON.stringify({ name: 'profile-probe' }),
			});
			expect(mint.status).toBe(200);
			const { rawToken } = (await mint.json()) as { rawToken: string };
			const viaToken = await patchProfile(rawToken, { name: 'Via Token' });
			expect(viaToken.status).toBe(403);
			expect(((await viaToken.json()) as { error: string }).error).toBe('session_required');

			// Flagged session (admin-created user, first login) → 403
			// password_change_required — the profile route is not a recovery path
			const flaggedEmail = uniqueEmail('profile-flagged');
			const created = await adminFetch(`${BASE}/api/admin/users`, {
				method: 'POST',
				body: JSON.stringify({
					name: 'Flagged Profile User',
					email: flaggedEmail,
					password: 'temppassword123',
				}),
			});
			expect(created.status).toBe(201);
			const flaggedLogin = await passwordLogin(flaggedEmail, 'temppassword123');
			expect(flaggedLogin.status).toBe(200);
			const flaggedToken = ((await flaggedLogin.json()) as { token: string }).token;
			const flagged = await patchProfile(flaggedToken, { name: 'Should Not Land' });
			expect(flagged.status).toBe(403);
			expect(((await flagged.json()) as { error: string }).error).toBe('password_change_required');
		},
	);

	it('targets only the caller — body-supplied identity fields cannot retarget or escalate', async () => {
		const caller = await createTestUser({
			email: uniqueEmail('profile-spoof'),
			password: 'testpassword123',
			name: 'Spoof Caller',
		});
		const victim = await createTestUser({
			email: uniqueEmail('profile-victim'),
			password: 'testpassword123',
			name: 'Spoof Victim',
		});

		// The body tries to act on the victim and to escalate the role
		const spoofEmail = uniqueEmail('profile-spoofed-email');
		const spoof = await patchProfile(caller.token!, {
			userId: victim.id,
			requestingUserId: victim.id,
			role: 'admin',
			name: 'Hacked Name',
			email: spoofEmail,
		});
		expect(spoof.status).toBe(200);
		const data = (await spoof.json()) as { user: WireUser };
		// The caller's own fields changed…
		expect(data.user.id).toBe(caller.id);
		expect(data.user.name).toBe('Hacked Name');
		expect(data.user.email).toBe(spoofEmail);
		// …and the role did not escalate
		expect(data.user.role).toBe('member');

		// The victim is untouched
		const victimUser = await meUser(victim.token!);
		expect(victimUser.name).toBe('Spoof Victim');
		expect(victimUser.email).toBe(victim.email);
		expect(victimUser.role).toBe('member');

		// A combined request rejected for an invalid field mutates neither
		const combined = await patchProfile(caller.token!, {
			name: 'Combined Name',
			email: null,
		});
		expect(combined.status).toBe(400);
		const after = await meUser(caller.token!);
		expect(after.name).toBe('Hacked Name');
		expect(after.email).toBe(spoofEmail);
	});

	it(
		'enforces integrity guards only — no email-format validation',
		{ timeout: 60000 },
		async () => {
			const user = await createTestUser({
				email: uniqueEmail('profile-guard'),
				password: 'testpassword123',
				name: 'Guard User',
			});
			const other = await createTestUser({
				email: uniqueEmail('profile-other'),
				password: 'testpassword123',
				name: 'Other User',
			});

			const rejections: Array<{ label: string; body: unknown; status: number; error: string }> = [
				{
					label: 'duplicate email',
					body: { email: other.email },
					status: 409,
					error: 'email_in_use',
				},
				{ label: 'blank name', body: { name: '   ' }, status: 400, error: 'invalid_name' },
				{
					label: 'oversized name',
					body: { name: 'x'.repeat(101) },
					status: 400,
					error: 'invalid_name',
				},
				{ label: 'null name', body: { name: null }, status: 400, error: 'invalid_name' },
				{ label: 'non-string name', body: { name: 42 }, status: 400, error: 'invalid_name' },
				{ label: 'blank email', body: { email: '   ' }, status: 400, error: 'invalid_email' },
				{ label: 'null email', body: { email: null }, status: 400, error: 'invalid_email' },
				{ label: 'non-string email', body: { email: 42 }, status: 400, error: 'invalid_email' },
				{
					label: 'oversized email',
					body: { email: `${'a'.repeat(255)}@example.com` },
					status: 400,
					error: 'invalid_email',
				},
				{ label: 'no fields', body: {}, status: 400, error: 'missing_fields' },
			];
			for (const rejection of rejections) {
				const response = await patchProfile(user.token!, rejection.body);
				expect(response.status, rejection.label).toBe(rejection.status);
				const data = (await response.json()) as { error: string };
				expect(data.error, rejection.label).toBe(rejection.error);
			}

			// Malformed / non-object bodies answer 400 invalid_json, never a 500
			const malformed = await SELF.fetch(`${BASE}/api/auth/profile`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
				body: 'not json at all',
			});
			expect(malformed.status).toBe(400);
			expect(((await malformed.json()) as { error: string }).error).toBe('invalid_json');
			const arrayBody = await patchProfile(user.token!, ['name', 'Hacker']);
			expect(arrayBody.status).toBe(400);
			expect(((await arrayBody.json()) as { error: string }).error).toBe('invalid_json');

			// Nothing above wrote anything
			expect((await meUser(user.token!)).name).toBe('Guard User');

			// No email-format validation by design: an @-less identifier is
			// accepted and becomes the login identifier
			const formatFreeEmail = `no-at-${Date.now()}`;
			const formatFree = await patchProfile(user.token!, { email: formatFreeEmail });
			expect(formatFree.status).toBe(200);
			const formatFreeLogin = await passwordLogin(formatFreeEmail, 'testpassword123');
			expect(formatFreeLogin.status).toBe(200);

			// Partial updates: each applies the supplied field, preserves the other
			const nameOnly = await patchProfile(user.token!, { name: 'Partial Name' });
			expect(nameOnly.status).toBe(200);
			let current = ((await nameOnly.json()) as { user: WireUser }).user;
			expect(current.name).toBe('Partial Name');
			expect(current.email).toBe(formatFreeEmail);

			const emailOnlyEmail = uniqueEmail('profile-partial');
			const emailOnly = await patchProfile(user.token!, { email: emailOnlyEmail });
			expect(emailOnly.status).toBe(200);
			current = ((await emailOnly.json()) as { user: WireUser }).user;
			expect(current.name).toBe('Partial Name');
			expect(current.email).toBe(emailOnlyEmail);

			// Normalization: trim + lowercase on the way in
			const mixedEmail = `  ${uniqueEmail('profile-mixed').toUpperCase()}  `;
			const normalized = await patchProfile(user.token!, { email: mixedEmail });
			expect(normalized.status).toBe(200);
			const normalizedEmail = mixedEmail.trim().toLowerCase();
			current = ((await normalized.json()) as { user: WireUser }).user;
			expect(current.email).toBe(normalizedEmail);

			// A normalized duplicate of another user's email still collides
			const clash = await patchProfile(user.token!, {
				email: `  ${other.email.toUpperCase()}  `,
			});
			expect(clash.status).toBe(409);
			expect(((await clash.json()) as { error: string }).error).toBe('email_in_use');

			// A normalized no-op writes nothing: updatedAt is untouched
			const before = await meUser(user.token!);
			const noop = await patchProfile(user.token!, { email: before.email.toUpperCase() });
			expect(noop.status).toBe(200);
			const after = await meUser(user.token!);
			expect(after.updatedAt).toBe(before.updatedAt);
		},
	);

	it(
		'audits changed fields; failed and no-op requests write nothing',
		{ timeout: 60000 },
		async () => {
			const user = await createTestUser({
				email: uniqueEmail('profile-audit'),
				password: 'testpassword123',
				name: 'Audit User',
			});

			// Fresh registration writes no audit rows
			expect(await auditFor(user.id)).toHaveLength(0);

			// One request changing both fields → exactly one row per changed field
			const newName = 'Audited Name';
			const newEmail = uniqueEmail('profile-audited');
			const update = await patchProfile(user.token!, { name: newName, email: newEmail });
			expect(update.status).toBe(200);

			const rows = await auditFor(user.id);
			expect(rows).toHaveLength(2);
			const renamed = rows.find((row) => row.action === 'user.renamed');
			const emailChanged = rows.find((row) => row.action === 'user.email_changed');
			expect(renamed).toBeDefined();
			expect(emailChanged).toBeDefined();
			for (const row of rows) {
				// Actor = the user themselves. The rows are written inside the
				// transaction after the UPDATE, so the actor lookup resolves
				// against the new name/email.
				expect(row.actorEmail).toBe(newEmail);
				expect(row.actorName).toBe(newName);
				expect(row.targetType).toBe('user');
				expect(row.targetId).toBe(user.id);
				expect(row.targetLabel).toBe(newEmail);
			}
			expect(renamed!.details).toEqual({ from: 'Audit User', to: newName });
			expect(emailChanged!.details).toEqual({ from: user.email, to: newEmail });

			// A rejected change (duplicate email) and a no-op write nothing
			const other = await createTestUser({
				email: uniqueEmail('profile-audit-other'),
				password: 'testpassword123',
				name: 'Audit Other User',
			});
			const rejected = await patchProfile(user.token!, { email: other.email });
			expect(rejected.status).toBe(409);
			const noop = await patchProfile(user.token!, { name: newName });
			expect(noop.status).toBe(200);

			const after = await auditFor(user.id);
			expect(after).toHaveLength(2);
		},
	);
});
