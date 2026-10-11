import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	getAdminPasskeySession,
	registerPasskeyCeremony,
} from './utils';
import { VirtualAuthenticator } from './webauthn-helper';

const BASE = 'http://localhost';

interface AdminUserShape {
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

/**
 * Walk the whole audit log (bounded) — the shared suite's log is fully
 * readable by the admin fixture, newest first.
 */
async function allAuditEntries(): Promise<AuditEntry[]> {
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
			hasMore: boolean;
		};
		entries.push(...data.entries);
		if (!data.nextCursor) return entries;
		cursor = data.nextCursor;
	}
	throw new Error('Audit log pagination did not terminate within 50 pages');
}

async function auditFor(targetId: string): Promise<AuditEntry[]> {
	return (await allAuditEntries()).filter((entry) => entry.targetId === targetId);
}

async function adminCreateUser(input: {
	name: string;
	email: string;
	password: string;
	role?: string;
}): Promise<{ response: Response; user?: AdminUserShape; error?: string }> {
	const response = await adminFetch(`${BASE}/api/admin/users`, {
		method: 'POST',
		body: JSON.stringify(input),
	});
	// Parse once: the response body cannot be re-read by callers
	const data = (await response.json()) as { user?: AdminUserShape; error?: string };
	return { response, user: data.user, error: data.error };
}

async function passwordLogin(
	email: string,
	password: string,
): Promise<{
	response: Response;
	data: {
		user?: { id: string };
		token?: string;
		authMethod?: string;
		mustChangePassword?: boolean;
		hasPasskey?: boolean;
	};
}> {
	const response = await SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	const data = (await response.json()) as {
		user?: { id: string };
		token?: string;
		authMethod?: string;
		mustChangePassword?: boolean;
		hasPasskey?: boolean;
	};
	return { response, data };
}

// An isolated AuthState DO instance (pristine storage) for the last-admin
// defense-in-depth checks that the shared instance cannot reach (it always
// has several admins by the time these tests run).
const ISOLATED_AUTH_STATE = () =>
	env.AUTH_STATE.get(env.AUTH_STATE.idFromName('admin-crud-isolated'));

describe('admin user administration', () => {
	describe('admin creates users with forced password change', () => {
		it('creates a user with the admin shape and forced change', async () => {
			const email = `created-${Date.now()}@example.com`;
			const { response, user } = await adminCreateUser({
				name: 'Created User',
				email,
				password: 'temppassword123',
			});
			expect(response.status).toBe(201);
			expect(user).toBeDefined();
			expect(user?.email).toBe(email);
			expect(user?.name).toBe('Created User');
			expect(user?.role).toBe('member');
			expect(user?.disabled).toBe(false);
			expect(user?.mustChangePassword).toBe(true);
			expect(user?.lastLoginAt).toBeNull();
			expect(user?.passkeyCount).toBe(0);
			expect(user?.membershipCount).toBe(0);

			// The audit row for the creation
			const rows = await auditFor(user!.id);
			expect(rows.some((row) => row.action === 'user.created')).toBe(true);
		});

		it('assigns the admin role when requested', async () => {
			const { response, user } = await adminCreateUser({
				name: 'Created Admin',
				email: `created-admin-${Date.now()}@example.com`,
				password: 'temppassword123',
				role: 'admin',
			});
			expect(response.status).toBe(201);
			expect(user?.role).toBe('admin');
		});

		it('validates inputs and rejects duplicates', async () => {
			const existing = `dupe-${Date.now()}@example.com`;
			const first = await adminCreateUser({
				name: 'Dup',
				email: existing,
				password: 'temppassword123',
			});
			expect(first.response.status).toBe(201);

			const bad = await adminCreateUser({
				name: 'Dup',
				email: existing,
				password: 'temppassword123',
			});
			expect(bad.response.status).toBe(409);
			expect(bad.error).toBe('user_exists');

			const invalidEmail = await adminCreateUser({
				name: 'Bad Email',
				email: 'not-an-email',
				password: 'temppassword123',
			});
			expect(invalidEmail.response.status).toBe(400);
			expect(invalidEmail.error).toBe('invalid_email');

			const shortPassword = await adminCreateUser({
				name: 'Bad Password',
				email: `shortpw-${Date.now()}@example.com`,
				password: 'short',
			});
			expect(shortPassword.response.status).toBe(400);
			expect(shortPassword.error).toBe('invalid_password');

			const blankName = await adminCreateUser({
				name: '   ',
				email: `blankname-${Date.now()}@example.com`,
				password: 'temppassword123',
			});
			expect(blankName.response.status).toBe(400);
			expect(blankName.error).toBe('missing_fields');

			const badRole = await adminCreateUser({
				name: 'Bad Role',
				email: `badrole-${Date.now()}@example.com`,
				password: 'temppassword123',
				role: 'owner',
			});
			expect(badRole.response.status).toBe(400);
			expect(badRole.error).toBe('invalid_role');
		});

		it('restricts the flagged session server-side and unblocks after the change', async () => {
			const email = `forced-${Date.now()}@example.com`;
			const { user } = await adminCreateUser({
				name: 'Forced Change',
				email,
				password: 'temppassword123',
			});
			expect(user).toBeDefined();

			// First sign-in with the temp password works and reports the flag
			const firstLogin = await passwordLogin(email, 'temppassword123');
			expect(firstLogin.response.status).toBe(200);
			expect(firstLogin.data.mustChangePassword).toBe(true);
			expect(firstLogin.data.authMethod).toBe('password');
			const flaggedToken = firstLogin.data.token!;
			expect(firstLogin.data.user?.id).toBe(user!.id);

			// lastLoginAt is stamped at mint
			const detail = await adminFetch(`${BASE}/api/admin/users/${user!.id}`);
			const detailData = (await detail.json()) as { user: AdminUserShape };
			expect(detailData.user.lastLoginAt).toBeTruthy();

			// Everything authMiddleware guards is off-limits…
			const blocked = [
				authFetch(flaggedToken, `${BASE}/api/projects`),
				authFetch(flaggedToken, `${BASE}/api/auth/tokens`, {
					method: 'POST',
					body: JSON.stringify({ name: 'should-not-mint' }),
				}),
				authFetch(flaggedToken, `${BASE}/api/auth/webauthn/register/options`, {
					method: 'POST',
					body: '{}',
				}),
				authFetch(flaggedToken, `${BASE}/api/admin/users`),
				// …including the /api/0 surface, in its {detail} error shape
				authFetch(flaggedToken, `${BASE}/api/0/organizations/`),
			];
			const blockedResponses = await Promise.all(blocked);
			for (const response of blockedResponses) {
				expect(response.status).toBe(403);
			}
			const projectsError = (await blockedResponses[0].json()) as { error: string };
			expect(projectsError.error).toBe('password_change_required');
			const tokensError = (await blockedResponses[1].json()) as { error: string };
			expect(tokensError.error).toBe('password_change_required');
			const api0Error = (await blockedResponses[4].json()) as { detail: string };
			expect(api0Error.detail).toBe('password_change_required');

			// …while the recovery paths stay usable
			const me = await authFetch(flaggedToken, `${BASE}/api/auth/me`);
			expect(me.status).toBe(200);
			const meData = (await me.json()) as { mustChangePassword?: boolean };
			expect(meData.mustChangePassword).toBe(true);

			// logout works from a flagged session (revokes it)
			const logout = await authFetch(flaggedToken, `${BASE}/api/auth/logout`, {
				method: 'POST',
			});
			expect(logout.status).toBe(200);
			const afterLogout = await authFetch(flaggedToken, `${BASE}/api/auth/me`);
			expect(afterLogout.status).toBe(401);

			// logout-all works from a fresh flagged session
			const secondLogin = await passwordLogin(email, 'temppassword123');
			expect(secondLogin.response.status).toBe(200);
			const logoutAll = await authFetch(secondLogin.data.token!, `${BASE}/api/auth/logout-all`, {
				method: 'POST',
			});
			expect(logoutAll.status).toBe(200);

			// The change itself is allowed…
			const thirdLogin = await passwordLogin(email, 'temppassword123');
			const change = await authFetch(thirdLogin.data.token!, `${BASE}/api/auth/change-password`, {
				method: 'POST',
				body: JSON.stringify({
					currentPassword: 'temppassword123',
					newPassword: 'brandnewpassword456',
				}),
			});
			expect(change.status).toBe(200);

			// …and a fresh login reports a clean session with full access
			const freshLogin = await passwordLogin(email, 'brandnewpassword456');
			expect(freshLogin.response.status).toBe(200);
			expect(freshLogin.data.mustChangePassword).toBe(false);
			const projects = await authFetch(freshLogin.data.token!, `${BASE}/api/projects`);
			expect(projects.status).toBe(200);
		});
	});

	describe('user update guards', () => {
		it('applies rename, email change, and disable atomically', async () => {
			const originalEmail = `atomic-${Date.now()}@example.com`;
			const { user } = await adminCreateUser({
				name: 'Atomic User',
				email: originalEmail,
				password: 'temppassword123',
			});
			// Sign in so a live session exists to be killed by the disable
			const login = await passwordLogin(originalEmail, 'temppassword123');
			expect(login.response.status).toBe(200);

			const newEmail = `atomic-new-${Date.now()}@example.com`;
			const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({
					name: 'Atomic Renamed',
					email: newEmail,
					disabled: true,
				}),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as { user: AdminUserShape };
			expect(data.user.name).toBe('Atomic Renamed');
			expect(data.user.email).toBe(newEmail);
			expect(data.user.disabled).toBe(true);

			// Disable killed the live session
			const deadSession = await authFetch(login.data.token!, `${BASE}/api/auth/me`);
			expect(deadSession.status).toBe(401);

			// The old email no longer logs in; the new one does (after enable)
			const oldLogin = await passwordLogin(originalEmail, 'temppassword123');
			expect(oldLogin.response.status).toBe(401);

			const enable = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ disabled: false }),
			});
			expect(enable.status).toBe(200);
			const newLogin = await passwordLogin(newEmail, 'temppassword123');
			expect(newLogin.response.status).toBe(200);
		});

		it('rejects final states where an admin would be disabled', async () => {
			const { user } = await adminCreateUser({
				name: 'Promote Disable',
				email: `promote-disable-${Date.now()}@example.com`,
				password: 'temppassword123',
			});

			// Promote + disable in one request → rejected
			const both = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'admin', disabled: true }),
			});
			expect(both.status).toBe(400);
			expect(((await both.json()) as { error: string }).error).toBe('cannot_disable_admin');

			// Promoting an already-disabled user without enabling → rejected
			const disable = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ disabled: true }),
			});
			expect(disable.status).toBe(200);
			const promoteDisabled = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'admin' }),
			});
			expect(promoteDisabled.status).toBe(400);
			expect(((await promoteDisabled.json()) as { error: string }).error).toBe(
				'cannot_disable_admin',
			);

			// Promote + enable in one atomic request → allowed
			const promoteEnabled = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'admin', disabled: false }),
			});
			expect(promoteEnabled.status).toBe(200);
			const promoted = (await promoteEnabled.json()) as { user: AdminUserShape };
			expect(promoted.user.role).toBe('admin');
			expect(promoted.user.disabled).toBe(false);

			// Demote + disable in one atomic request → allowed
			const demoteDisable = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'member', disabled: true }),
			});
			expect(demoteDisable.status).toBe(200);
		});

		it('mutates nothing when one field in a multi-field request is invalid', async () => {
			const { user } = await adminCreateUser({
				name: 'Partial Fail',
				email: `partial-${Date.now()}@example.com`,
				password: 'temppassword123',
			});

			const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'Should Not Apply', email: 'not-an-email' }),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe('invalid_email');

			const detail = await adminFetch(`${BASE}/api/admin/users/${user!.id}`);
			const detailData = (await detail.json()) as { user: AdminUserShape };
			expect(detailData.user.name).toBe('Partial Fail');
			expect(detailData.user.email).toBe(user!.email);
		});

		it('allows self rename with role omitted (not a demotion)', async () => {
			const session = await getAdminPasskeySession();
			const response = await adminFetch(`${BASE}/api/admin/users/${session.userId}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'Admin Fixture' }),
			});
			expect(response.status).toBe(200);
		});

		it('rejects explicit self-demotion and self-delete', async () => {
			const session = await getAdminPasskeySession();
			const demote = await adminFetch(`${BASE}/api/admin/users/${session.userId}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'member' }),
			});
			expect(demote.status).toBe(403);
			expect(((await demote.json()) as { error: string }).error).toBe('cannot_demote_self');

			const remove = await adminFetch(`${BASE}/api/admin/users/${session.userId}`, {
				method: 'DELETE',
			});
			expect(remove.status).toBe(403);
			expect(((await remove.json()) as { error: string }).error).toBe('cannot_delete_self');
		});

		it('rejects emails already in use', async () => {
			const other = await createTestUser({
				email: `email-taken-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Email Taken',
			});
			const { user } = await adminCreateUser({
				name: 'Email Clash',
				email: `clash-${Date.now()}@example.com`,
				password: 'temppassword123',
			});

			const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ email: other.email }),
			});
			expect(response.status).toBe(409);
			expect(((await response.json()) as { error: string }).error).toBe('email_in_use');
		});

		it('demotes a non-last admin (positive control for the count guard)', async () => {
			const { user } = await adminCreateUser({
				name: 'Temp Admin',
				email: `temp-admin-${Date.now()}@example.com`,
				password: 'temppassword123',
				role: 'admin',
			});
			const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ role: 'member' }),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as { user: AdminUserShape };
			expect(data.user.role).toBe('member');
		});

		it('guards the last admin (defense in depth, direct DO on an isolated instance)', async () => {
			// A pristine AuthState instance: its first registered user is the
			// sole admin. The public API can never reach these guards (self
			// guards fire first), so this drives the internal handler with a
			// synthetic requester context directly.
			const stub = ISOLATED_AUTH_STATE();
			const register = await stub.fetch('http://internal/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'sole-admin@example.com',
					password: 'soleadminpassword123',
					name: 'Sole Admin',
					setupToken: 'test-setup-token',
				}),
			});
			expect(register.status).toBe(200);
			const registered = (await register.json()) as { user: { id: string } };

			const demote = await stub.fetch('http://internal/admin/update-user', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					requestingUserId: '00000000-0000-0000-0000-0000000000ff',
					requestingUserRole: 'admin',
					userId: registered.user.id,
					role: 'member',
				}),
			});
			expect(demote.status).toBe(403);
			expect(((await demote.json()) as { error: string }).error).toBe('last_admin');

			const remove = await stub.fetch('http://internal/admin/delete-user', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					requestingUserId: '00000000-0000-0000-0000-0000000000ff',
					requestingUserRole: 'admin',
					userId: registered.user.id,
				}),
			});
			expect(remove.status).toBe(403);
			expect(((await remove.json()) as { error: string }).error).toBe('last_admin');
		});
	});

	describe('password reset and passkey removal', () => {
		it('reset revokes sessions, forces a change, and pauses API tokens until the change', async () => {
			const user = await createTestUser({
				email: `reset-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Reset User',
			});

			// A passkey and an API token exist before the reset
			const authenticator = new VirtualAuthenticator();
			await authenticator.init();
			const register = await registerPasskeyCeremony(user.token!, authenticator);
			expect(register.status).toBe(200);

			const mint = await authFetch(user.token!, `${BASE}/api/auth/tokens`, {
				method: 'POST',
				body: JSON.stringify({ name: 'reset-test' }),
			});
			expect(mint.status).toBe(200);
			const { rawToken } = (await mint.json()) as { rawToken: string };
			const tokenWorks = await authFetch(rawToken, `${BASE}/api/projects`);
			expect(tokenWorks.status).toBe(200);

			// Admin reset
			const reset = await adminFetch(`${BASE}/api/admin/users/${user.id}/reset-password`, {
				method: 'POST',
				body: JSON.stringify({ newPassword: 'temporarypass456' }),
			});
			expect(reset.status).toBe(200);
			const resetData = (await reset.json()) as { user: AdminUserShape };
			expect(resetData.user.mustChangePassword).toBe(true);

			// Old session revoked
			const deadSession = await authFetch(user.token!, `${BASE}/api/auth/me`);
			expect(deadSession.status).toBe(401);

			// Existing API token paused with the specific error
			const paused = await authFetch(rawToken, `${BASE}/api/projects`);
			expect(paused.status).toBe(401);
			const pausedError = (await paused.json()) as { error: string };
			expect(pausedError.error).toBe('password_change_required');

			// Sign-in with the temp password reports the flag and the passkey
			const login = await passwordLogin(user.email, 'temporarypass456');
			expect(login.response.status).toBe(200);
			expect(login.data.mustChangePassword).toBe(true);
			expect(login.data.hasPasskey).toBe(true);

			// Remove the passkeys
			const removePasskeys = await adminFetch(`${BASE}/api/admin/users/${user.id}/passkeys`, {
				method: 'DELETE',
			});
			expect(removePasskeys.status).toBe(200);
			expect(((await removePasskeys.json()) as { removedCount: number }).removedCount).toBe(1);

			const afterRemoval = await passwordLogin(user.email, 'temporarypass456');
			expect(afterRemoval.response.status).toBe(200);
			expect(afterRemoval.data.hasPasskey).toBe(false);

			// Removing passkeys again is a no-op returning zero
			const removeAgain = await adminFetch(`${BASE}/api/admin/users/${user.id}/passkeys`, {
				method: 'DELETE',
			});
			expect(((await removeAgain.json()) as { removedCount: number }).removedCount).toBe(0);

			// The user completes the change; the paused token resumes
			const change = await authFetch(afterRemoval.data.token!, `${BASE}/api/auth/change-password`, {
				method: 'POST',
				body: JSON.stringify({
					currentPassword: 'temporarypass456',
					newPassword: 'finalpassword789',
				}),
			});
			expect(change.status).toBe(200);

			const freshLogin = await passwordLogin(user.email, 'finalpassword789');
			expect(freshLogin.response.status).toBe(200);
			expect(freshLogin.data.mustChangePassword).toBe(false);

			const resumed = await authFetch(rawToken, `${BASE}/api/projects`);
			expect(resumed.status).toBe(200);
		});

		it('validates the new password', async () => {
			const user = await createTestUser({
				email: `reset-invalid-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Reset Invalid',
			});
			const response = await adminFetch(`${BASE}/api/admin/users/${user.id}/reset-password`, {
				method: 'POST',
				body: JSON.stringify({ newPassword: 'short' }),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe('invalid_password');
		});
	});

	describe('user delete cascades and blocks on owned projects', () => {
		it('blocks deletion while the user owns projects and succeeds after reassignment', async () => {
			const owner = await createTestUser({
				email: `delete-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Delete Owner',
			});
			const project = await createTestProject(owner.token!, {
				name: `Owned Project ${Date.now()}`,
			});

			// Blocked with the project list
			const blocked = await adminFetch(`${BASE}/api/admin/users/${owner.id}`, {
				method: 'DELETE',
			});
			expect(blocked.status).toBe(409);
			const blockedData = (await blocked.json()) as {
				error: string;
				projects: Array<{ id: string; name: string; slug: string }>;
			};
			expect(blockedData.error).toBe('owns_projects');
			expect(blockedData.projects).toHaveLength(1);
			expect(blockedData.projects[0].id).toBe(project.id);
			expect(blockedData.projects[0].slug).toBe(project.slug);

			// Reassign ownership, then the delete succeeds
			const successor = await createTestUser({
				email: `successor-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Successor',
			});
			const reassign = await adminFetch(`${BASE}/api/admin/projects/${project.id}/owner`, {
				method: 'POST',
				body: JSON.stringify({ userId: successor.id }),
			});
			expect(reassign.status).toBe(200);

			const remove = await adminFetch(`${BASE}/api/admin/users/${owner.id}`, {
				method: 'DELETE',
			});
			expect(remove.status).toBe(200);

			// Cascades: login dead, user gone from the list, membership gone
			const login = await passwordLogin(owner.email, owner.password);
			expect(login.response.status).toBe(401);

			const list = await adminFetch(`${BASE}/api/admin/users`);
			const listData = (await list.json()) as { users: Array<{ id: string }> };
			expect(listData.users.some((u) => u.id === owner.id)).toBe(false);

			const roster = await authFetch(
				successor.token!,
				`${BASE}/api/projects/${project.slug}/members`,
			);
			const rosterData = (await roster.json()) as { members: Array<{ userId: string }> };
			expect(rosterData.members.some((m) => m.userId === owner.id)).toBe(false);
		});

		it('returns 404 for unknown users', async () => {
			const response = await adminFetch(
				`${BASE}/api/admin/users/00000000-0000-0000-0000-000000000000`,
				{ method: 'DELETE' },
			);
			expect(response.status).toBe(404);
		});
	});

	describe('project admin lifecycle', () => {
		it('creates a project with an assigned owner and returns the DSN', async () => {
			const owner = await createTestUser({
				email: `proj-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Project Owner',
			});
			const session = await getAdminPasskeySession();
			const response = await adminFetch(`${BASE}/api/admin/projects`, {
				method: 'POST',
				body: JSON.stringify({
					name: `Admin Created ${Date.now()}`,
					platform: 'javascript',
					ownerId: owner.id,
				}),
			});
			expect(response.status).toBe(201);
			const data = (await response.json()) as {
				project: { id: string; name: string; slug: string; publicKey: string };
				dsn: string;
			};
			expect(data.project.slug).toBeTruthy();
			expect(data.project.publicKey).toBeTruthy();
			expect(data.dsn).toContain(data.project.publicKey);
			expect(data.dsn).toContain(data.project.id);

			// The assigned owner holds the owner role…
			const roster = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${data.project.slug}/members`,
			);
			const rosterData = (await roster.json()) as {
				members: Array<{ userId: string; role: string }>;
			};
			expect(rosterData.members).toHaveLength(1);
			expect(rosterData.members[0].userId).toBe(owner.id);
			expect(rosterData.members[0].role).toBe('owner');

			// …and the creating admin was NOT auto-added
			const creatorProjects = await authFetch(session.token, `${BASE}/api/projects`);
			const creatorData = (await creatorProjects.json()) as { projects: Array<{ id: string }> };
			expect(creatorData.projects.some((p) => p.id === data.project.id)).toBe(false);

			// The audit row records the creation with the owner email
			const rows = await auditFor(data.project.id);
			expect(
				rows.some(
					(row) =>
						row.action === 'project.created' &&
						(row.details as { ownerEmail?: string } | null)?.ownerEmail === owner.email,
				),
			).toBe(true);
		});

		it('rejects creation with an unknown owner', async () => {
			const response = await adminFetch(`${BASE}/api/admin/projects`, {
				method: 'POST',
				body: JSON.stringify({
					name: `No Owner ${Date.now()}`,
					ownerId: '00000000-0000-0000-0000-000000000000',
				}),
			});
			expect(response.status).toBe(404);
			expect(((await response.json()) as { error: string }).error).toBe('user_not_found');
		});

		it('requires a name and mints unique slugs for duplicate names', async () => {
			const owner = await createTestUser({
				email: `slug-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Slug Owner',
			});

			const missingName = await adminFetch(`${BASE}/api/admin/projects`, {
				method: 'POST',
				body: JSON.stringify({ ownerId: owner.id }),
			});
			expect(missingName.status).toBe(400);
			expect(((await missingName.json()) as { error: string }).error).toBe('missing_fields');

			const name = `Duplicate Name ${Date.now()}`;
			const first = await adminFetch(`${BASE}/api/admin/projects`, {
				method: 'POST',
				body: JSON.stringify({ name, ownerId: owner.id }),
			});
			expect(first.status).toBe(201);
			const second = await adminFetch(`${BASE}/api/admin/projects`, {
				method: 'POST',
				body: JSON.stringify({ name, ownerId: owner.id }),
			});
			expect(second.status).toBe(201);
			const firstProject = (await first.json()) as { project: { slug: string } };
			const secondProject = (await second.json()) as { project: { slug: string } };
			expect(secondProject.project.slug).not.toBe(firstProject.project.slug);
			expect(secondProject.project.slug).toMatch(/-\d+$/);
		});

		it('renames the project without touching the slug', async () => {
			const owner = await createTestUser({
				email: `rename-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Rename Owner',
			});
			const project = await createTestProject(owner.token!, {
				name: `Rename Me ${Date.now()}`,
			});

			const response = await adminFetch(`${BASE}/api/admin/projects/${project.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'Renamed Display Name' }),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				project: { name: string; slug: string };
			};
			expect(data.project.name).toBe('Renamed Display Name');
			expect(data.project.slug).toBe(project.slug);

			// The owner still resolves the project by the unchanged slug
			const fetched = await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}`);
			expect(fetched.status).toBe(200);
			const fetchedData = (await fetched.json()) as { project: { name: string } };
			expect(fetchedData.project.name).toBe('Renamed Display Name');
		});

		it('reassigns ownership and demotes the previous owner to project-admin', async () => {
			const originalOwner = await createTestUser({
				email: `orig-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Original Owner',
			});
			const newOwner = await createTestUser({
				email: `new-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'New Owner',
			});
			const project = await createTestProject(originalOwner.token!, {
				name: `Reassign Me ${Date.now()}`,
			});

			const response = await adminFetch(`${BASE}/api/admin/projects/${project.id}/owner`, {
				method: 'POST',
				body: JSON.stringify({ userId: newOwner.id }),
			});
			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				owner: { userId: string };
				previousOwner: { userId: string } | null;
			};
			expect(data.owner.userId).toBe(newOwner.id);
			expect(data.previousOwner?.userId).toBe(originalOwner.id);

			// Roster: new owner is owner; previous owner is project-admin
			const roster = await authFetch(
				newOwner.token!,
				`${BASE}/api/projects/${project.slug}/members`,
			);
			const rosterData = (await roster.json()) as {
				members: Array<{ userId: string; role: string }>;
			};
			const byId = new Map(rosterData.members.map((m) => [m.userId, m.role]));
			expect(byId.get(newOwner.id)).toBe('owner');
			expect(byId.get(originalOwner.id)).toBe('admin');

			// Reassigning to the current owner is rejected
			const again = await adminFetch(`${BASE}/api/admin/projects/${project.id}/owner`, {
				method: 'POST',
				body: JSON.stringify({ userId: newOwner.id }),
			});
			expect(again.status).toBe(400);
			expect(((await again.json()) as { error: string }).error).toBe('already_owner');

			// Unknown owner / project
			const unknownUser = await adminFetch(`${BASE}/api/admin/projects/${project.id}/owner`, {
				method: 'POST',
				body: JSON.stringify({ userId: '00000000-0000-0000-0000-000000000000' }),
			});
			expect(unknownUser.status).toBe(404);
			expect(((await unknownUser.json()) as { error: string }).error).toBe('user_not_found');

			const unknownProject = await adminFetch(
				`${BASE}/api/admin/projects/00000000-0000-0000-0000-000000000000/owner`,
				{
					method: 'POST',
					body: JSON.stringify({ userId: newOwner.id }),
				},
			);
			expect(unknownProject.status).toBe(404);
			expect(((await unknownProject.json()) as { error: string }).error).toBe('project_not_found');
		});

		it('admin deletion purges the ProjectState DO', async () => {
			const owner = await createTestUser({
				email: `purge-admin-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Purge Admin Owner',
			});
			const project = await createTestProject(owner.token!, {
				name: `Admin Purge ${Date.now()}`,
			});

			// Ingest an event so the ProjectState DO has data
			const envelope = JSON.stringify({
				event_id: crypto.randomUUID().replace(/-/g, ''),
				dsn: `https://${project.publicKey}@localhost/${project.id}`,
				sdk: { name: 'sentry.javascript.browser', version: '7.0.0' },
			})
				.concat('\n')
				.concat(JSON.stringify({ type: 'event' }))
				.concat('\n')
				.concat(
					JSON.stringify({
						event_id: crypto.randomUUID().replace(/-/g, ''),
						timestamp: new Date().toISOString(),
						platform: 'javascript',
						exception: { values: [{ type: 'Error', value: 'admin purge me' }] },
					}),
				);
			const ingest = await SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-sentry-envelope',
					'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
				},
				body: envelope,
			});
			expect(ingest.status).toBe(200);

			const remove = await adminFetch(`${BASE}/api/admin/projects/${project.id}`, {
				method: 'DELETE',
			});
			expect(remove.status).toBe(200);

			// Ingestion to the deleted project now 404s (DSN key gone)
			const ingestAfter = await SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-sentry-envelope',
					'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
				},
				body: envelope,
			});
			expect(ingestAfter.status).toBe(401);
			const ingestError = (await ingestAfter.json()) as { error: string };
			expect(ingestError.error).toBe('invalid_auth');

			// The ProjectState DO itself is empty (purge.test.ts pattern)
			const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
			const issues = await stub.fetch(
				new Request('http://internal/issues', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
				}),
			);
			if (issues.ok) {
				const data = (await issues.json()) as { issues?: unknown[] };
				const list = data.issues ?? (data as unknown as unknown[]);
				expect(list.length).toBe(0);
			} else {
				const errorText = await issues.text();
				expect(errorText).toContain('no such table');
			}
		});
	});

	describe('membership is admin-managed', () => {
		it('lets a non-member admin manage members; protects the owner', async () => {
			const owner = await createTestUser({
				email: `member-owner-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Member Owner',
			});
			const project = await createTestProject(owner.token!, {
				name: `Admin Members ${Date.now()}`,
			});

			// Add by email (the admin is not a member of this project)
			const added = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: owner.email, role: 'member' }),
			});
			expect(added.status).toBe(409); // owner is already a member
			expect(((await added.json()) as { error: string }).error).toBe('already_member');

			const outsider = await createTestUser({
				email: `outsider-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Outsider',
			});
			const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: outsider.email, role: 'member' }),
			});
			expect(add.status).toBe(201);
			const addData = (await add.json()) as { member: { userId: string; role: string } };
			expect(addData.member.userId).toBe(outsider.id);
			expect(addData.member.role).toBe('member');

			// Unknown email
			const unknown = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: 'nobody@example.com', role: 'member' }),
			});
			expect(unknown.status).toBe(404);
			expect(((await unknown.json()) as { error: string }).error).toBe('user_not_found');

			// Owner role is not assignable here (reassign-owner only)
			const ownerRole = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: outsider.email, role: 'owner' }),
			});
			expect(ownerRole.status).toBe(400);
			expect(((await ownerRole.json()) as { error: string }).error).toBe('invalid_role');

			// Change role member → admin
			const promote = await adminFetch(
				`${BASE}/api/admin/projects/${project.id}/members/${outsider.id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(promote.status).toBe(200);
			const promoteData = (await promote.json()) as { member: { role: string } };
			expect(promoteData.member.role).toBe('admin');

			// The owner's role cannot be modified or removed
			const patchOwner = await adminFetch(
				`${BASE}/api/admin/projects/${project.id}/members/${owner.id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ role: 'member' }),
				},
			);
			expect(patchOwner.status).toBe(400);
			expect(((await patchOwner.json()) as { error: string }).error).toBe('cannot_modify_owner');

			const removeOwner = await adminFetch(
				`${BASE}/api/admin/projects/${project.id}/members/${owner.id}`,
				{ method: 'DELETE' },
			);
			expect(removeOwner.status).toBe(400);
			expect(((await removeOwner.json()) as { error: string }).error).toBe('cannot_remove_owner');

			// Remove the (non-owner) member
			const remove = await adminFetch(
				`${BASE}/api/admin/projects/${project.id}/members/${outsider.id}`,
				{ method: 'DELETE' },
			);
			expect(remove.status).toBe(200);

			// Roster read stays available to plain members
			const member = await createTestUser({
				email: `roster-member-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Roster Member',
			});
			await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: member.email, role: 'member' }),
			});
			const roster = await authFetch(member.token!, `${BASE}/api/projects/${project.slug}/members`);
			expect(roster.status).toBe(200);
			const rosterData = (await roster.json()) as { members: Array<{ userId: string }> };
			expect(rosterData.members.some((m) => m.userId === member.id)).toBe(true);
		});

		it('old project-level member mutation routes are gone (404 authenticated)', async () => {
			const owner = await createTestUser({
				email: `old-routes-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Old Routes Owner',
			});
			const project = await createTestProject(owner.token!, {
				name: `Old Routes ${Date.now()}`,
			});

			const post = await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: owner.email, role: 'member' }),
			});
			expect(post.status).toBe(404);

			const patch = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${project.slug}/members/${owner.id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ role: 'member' }),
				},
			);
			expect(patch.status).toBe(404);

			const remove = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${project.slug}/members/${owner.id}`,
				{ method: 'DELETE' },
			);
			expect(remove.status).toBe(404);
		});
	});

	describe('audit log records admin actions', () => {
		it('records actor, action, and target for each mutation', async () => {
			const session = await getAdminPasskeySession();
			const email = `audit-user-${Date.now()}@example.com`;
			const { user } = await adminCreateUser({
				name: 'Audit User',
				email,
				password: 'temppassword123',
			});
			expect(user).toBeDefined();

			const rows = await auditFor(user!.id);
			const created = rows.find((row) => row.action === 'user.created');
			expect(created).toBeDefined();
			expect(created?.actorEmail).toBe('admin-fixture@example.com');
			expect(created?.actorName).toBe('Admin Fixture');
			expect(created?.targetType).toBe('user');
			expect(created?.targetLabel).toBe(email);
			expect(created?.createdAt).toBeTruthy();
			// The actor is the fixture's (passkey-session) user id
			expect(created?.details).toMatchObject({ role: 'member' });
			expect(session.userId).toBeTruthy();
		});

		it('writes no rows for failed or no-op mutations', async () => {
			const email = `audit-noop-${Date.now()}@example.com`;
			const { user } = await adminCreateUser({
				name: 'Audit Noop',
				email,
				password: 'temppassword123',
			});
			expect(user).toBeDefined();

			// Failed mutation: duplicate email
			await adminCreateUser({ name: 'Dup', email, password: 'temppassword123' });
			// No-op mutation: same name, same values
			await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'Audit Noop' }),
			});

			const rows = await auditFor(user!.id);
			expect(rows).toHaveLength(1);
			expect(rows[0].action).toBe('user.created');
		});

		it('writes one row per changed field on multi-field updates', async () => {
			const { user } = await adminCreateUser({
				name: 'Audit Multi',
				email: `audit-multi-${Date.now()}@example.com`,
				password: 'temppassword123',
			});
			expect(user).toBeDefined();

			const newEmail = `audit-multi-new-${Date.now()}@example.com`;
			const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'Audit Multi Renamed', email: newEmail }),
			});
			expect(response.status).toBe(200);

			const rows = await auditFor(user!.id);
			const actions = rows.map((row) => row.action);
			expect(actions).toContain('user.created');
			expect(actions).toContain('user.renamed');
			expect(actions).toContain('user.email_changed');
			expect(actions.filter((a) => a === 'user.renamed')).toHaveLength(1);
			expect(actions.filter((a) => a === 'user.email_changed')).toHaveLength(1);
		});

		it('paginates newest-first with a keyset cursor and clamped limits', async () => {
			// Generate a deterministic block of audit rows (30 renames)
			const { user } = await adminCreateUser({
				name: 'Audit Pager',
				email: `audit-pager-${Date.now()}@example.com`,
				password: 'temppassword123',
			});
			expect(user).toBeDefined();
			for (let i = 0; i < 30; i++) {
				const response = await adminFetch(`${BASE}/api/admin/users/${user!.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ name: `Audit Pager ${i}` }),
				});
				expect(response.status).toBe(200);
			}
			const pagerRows = await auditFor(user!.id);
			expect(pagerRows.filter((row) => row.action === 'user.renamed')).toHaveLength(30);

			// Default page size 25 (below-1 and non-numeric fall back to it)
			const page = await adminFetch(`${BASE}/api/admin/audit`);
			const pageData = (await page.json()) as {
				entries: AuditEntry[];
				nextCursor?: string;
				hasMore: boolean;
			};
			expect(pageData.entries).toHaveLength(25);
			expect(pageData.hasMore).toBe(true);
			expect(pageData.nextCursor).toBeTruthy();
			// Newest first
			for (let i = 1; i < pageData.entries.length; i++) {
				expect(pageData.entries[i - 1].createdAt >= pageData.entries[i].createdAt).toBe(true);
			}

			const zero = await adminFetch(`${BASE}/api/admin/audit?limit=0`);
			expect(((await zero.json()) as { entries: AuditEntry[] }).entries).toHaveLength(25);
			const nan = await adminFetch(`${BASE}/api/admin/audit?limit=abc`);
			expect(((await nan.json()) as { entries: AuditEntry[] }).entries).toHaveLength(25);

			// Above 100 clamps to 100
			const big = await adminFetch(`${BASE}/api/admin/audit?limit=500`);
			const bigData = (await big.json()) as { entries: AuditEntry[] };
			expect(bigData.entries.length).toBeLessThanOrEqual(100);

			// Cursor pagination walks strictly older pages without overlap
			const first = await adminFetch(`${BASE}/api/admin/audit?limit=2`);
			const firstData = (await first.json()) as {
				entries: AuditEntry[];
				nextCursor: string;
				hasMore: boolean;
			};
			expect(firstData.entries).toHaveLength(2);
			expect(firstData.hasMore).toBe(true);

			const second = await adminFetch(
				`${BASE}/api/admin/audit?limit=2&cursor=${encodeURIComponent(firstData.nextCursor)}`,
			);
			const secondData = (await second.json()) as { entries: AuditEntry[]; nextCursor?: string };
			expect(secondData.entries).toHaveLength(2);
			expect(secondData.entries[0].createdAt <= firstData.entries[1].createdAt).toBe(true);
			const firstIds = new Set(firstData.entries.map((entry) => entry.id));
			for (const entry of secondData.entries) {
				expect(firstIds.has(entry.id)).toBe(false);
			}

			// A malformed cursor is treated as absent (first page)
			const malformed = await adminFetch(
				`${BASE}/api/admin/audit?limit=2&cursor=this-is-not-a-cursor`,
			);
			const malformedData = (await malformed.json()) as { entries: AuditEntry[] };
			expect(malformedData.entries[0].id).toBe(firstData.entries[0].id);
		});
	});
});
