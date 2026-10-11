import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readCappedJson } from '../lib/capped-json';
import { purgeProjectState } from '../lib/project-purge';
import { extractBearerToken } from '../middleware/auth';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Streaming body cap for admin route bodies (16 KiB), like the passkey endpoints. */
const MAX_ADMIN_BODY_BYTES = 16 * 1024;

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// The admin gate
// ---------------------------------------------------------------------------
// Runs after the app-level authMiddleware (index.ts), which already rejects
// anonymous and invalid/expired credentials with 401 and password-change-
// flagged credentials with 403 `password_change_required`. Three ordered
// checks with distinct errors:
//   1. raw `wst_` bearer  → 403 `session_required` — AuthContext.session is
//      synthesized for API tokens, so presence cannot discriminate and the
//      raw token prefix is the discriminator (same pattern as the passkey
//      register/manage guard). Invalid/expired tokens never reach this
//      check: authMiddleware already 401'd them.
//   2. non-admin role     → 403 `forbidden`
//   3. session not minted by a passkey login → 403 `passkey_required`
//      (registering a passkey inside a password session does NOT unlock
//      admin tools — re-login via passkey is required)
adminRoutes.use('*', async (c, next) => {
	const auth = c.get('auth');
	if (!auth) {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return c.json({ error: 'unauthorized' }, 401);
	}
	const token = extractBearerToken(c.req.header('Authorization'));
	if (token?.startsWith('wst_')) {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return c.json(
			{
				error: 'session_required',
				message: 'Admin actions require a dashboard session (API tokens are not accepted)',
			},
			403,
		);
	}
	if (auth.user.role !== 'admin') {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return c.json({ error: 'forbidden', message: 'Admin role required' }, 403);
	}
	if (auth.session.authMethod !== 'passkey') {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return c.json(
			{
				error: 'passkey_required',
				message: 'Admin actions require signing in with a passkey',
			},
			403,
		);
	}
	return next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authStateFetch(env: Env, path: string, body: unknown): Promise<Response> {
	const id = env.AUTH_STATE.idFromName('global');
	const stub = env.AUTH_STATE.get(id);
	return stub.fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

function auth(c: AppContext): AuthContext {
	return c.get('auth') as AuthContext;
}

/** Fully discard the request body (workerd hygiene: never leave it unread). */
async function discardBody(c: AppContext): Promise<void> {
	await c.req.raw.body?.cancel().catch(() => undefined);
}

/** Read an admin request body under the shared streaming cap. */
async function adminBody(c: AppContext): Promise<Record<string, unknown> | Response> {
	const parsed = await readCappedJson(c, MAX_ADMIN_BODY_BYTES);
	return parsed.ok ? parsed.body : parsed.response;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// List all registered users (admin only)
// GET /api/admin/users
adminRoutes.get('/users', async (c) => {
	const response = await authStateFetch(c.env, '/list-users', {
		requestingUserRole: auth(c).user.role,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Create a user (temporary password; forced change at first sign-in)
// POST /api/admin/users  { name, email, password, role? }
adminRoutes.post('/users', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/create-user', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		...body,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// User detail with memberships
// GET /api/admin/users/:userId
adminRoutes.get('/users/:userId', async (c) => {
	const response = await authStateFetch(c.env, '/admin/get-user', {
		requestingUserRole: auth(c).user.role,
		userId: c.req.param('userId'),
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Update a user atomically (name/email/role/disabled, any subset)
// PATCH /api/admin/users/:userId  { name?, email?, role?, disabled? }
adminRoutes.patch('/users/:userId', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/update-user', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		userId: c.req.param('userId'),
		...body,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Reset a user's password (revokes sessions, forces change at next sign-in)
// POST /api/admin/users/:userId/reset-password  { newPassword }
adminRoutes.post('/users/:userId/reset-password', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/reset-user-password', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		userId: c.req.param('userId'),
		newPassword: body.newPassword,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Remove every passkey for a user
// DELETE /api/admin/users/:userId/passkeys
adminRoutes.delete('/users/:userId/passkeys', async (c) => {
	await discardBody(c);
	const response = await authStateFetch(c.env, '/admin/remove-user-passkeys', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		userId: c.req.param('userId'),
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Delete a user (blocked while they own projects)
// DELETE /api/admin/users/:userId
adminRoutes.delete('/users/:userId', async (c) => {
	await discardBody(c);
	const response = await authStateFetch(c.env, '/admin/delete-user', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		userId: c.req.param('userId'),
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// ---------------------------------------------------------------------------
// Projects + membership (centralized administration)
// ---------------------------------------------------------------------------

// Every project with owner and member count
// GET /api/admin/projects
adminRoutes.get('/projects', async (c) => {
	const response = await authStateFetch(c.env, '/admin/list-all-projects', {
		requestingUserRole: auth(c).user.role,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Create a project with an assigned owner (creator is not auto-added)
// POST /api/admin/projects  { name, platform?, ownerId }
adminRoutes.post('/projects', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/create-project', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		name: body.name,
		platform: body.platform,
		ownerId: body.ownerId,
	});
	const data = (await response.json()) as {
		project?: { id: string; publicKey: string };
	} & Record<string, unknown>;
	if (!response.ok || !data.project) {
		return c.json(data, response.status as ContentfulStatusCode);
	}
	// DSN built from the request host, mirroring the project read routes
	const host = new URL(c.req.url).host;
	const dsn = `https://${data.project.publicKey}@${host}/${data.project.id}`;
	return c.json({ ...data, dsn }, response.status as ContentfulStatusCode);
});

// Rename a project (display name only; the slug is immutable)
// PATCH /api/admin/projects/:projectId  { name }
adminRoutes.patch('/projects/:projectId', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/rename-project', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId: c.req.param('projectId'),
		name: body.name,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Reassign ownership (previous owner stays as project-admin)
// POST /api/admin/projects/:projectId/owner  { userId }
adminRoutes.post('/projects/:projectId/owner', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/reassign-owner', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId: c.req.param('projectId'),
		newOwnerId: body.userId,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Delete a project (registry rows here; ProjectState purge below)
// DELETE /api/admin/projects/:projectId
adminRoutes.delete('/projects/:projectId', async (c) => {
	const projectId = c.req.param('projectId');
	const faultHeader = c.req.header('X-Sentinel-Test-Fault');
	await discardBody(c);
	const response = await authStateFetch(c.env, '/admin/delete-project', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId,
	});
	const data = await response.json();
	if (!response.ok) {
		return c.json(data, response.status as ContentfulStatusCode);
	}
	// Same ProjectState purge saga the owner-delete path runs (R2 sweep
	// first, alarm retry, 503 ingest rejection while pending)
	await purgeProjectState(c.env, projectId, { faultHeader });
	return c.json(data, response.status as ContentfulStatusCode);
});

// Project roster (reuse of the membership-gated internal lister)
// GET /api/admin/projects/:projectId/members
adminRoutes.get('/projects/:projectId/members', async (c) => {
	const response = await authStateFetch(c.env, '/list-project-members', {
		projectId: c.req.param('projectId'),
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Add a member to any project (owner assignment goes through /owner)
// POST /api/admin/projects/:projectId/members  { email, role }
adminRoutes.post('/projects/:projectId/members', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/add-project-member', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId: c.req.param('projectId'),
		email: body.email,
		role: body.role,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Change a member's role (admin|member; the owner's role is fixed)
// PATCH /api/admin/projects/:projectId/members/:userId  { role }
adminRoutes.patch('/projects/:projectId/members/:userId', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/admin/update-project-member-role', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId: c.req.param('projectId'),
		userId: c.req.param('userId'),
		role: body.role,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// Remove a member from any project (owner must be reassigned first)
// DELETE /api/admin/projects/:projectId/members/:userId
adminRoutes.delete('/projects/:projectId/members/:userId', async (c) => {
	await discardBody(c);
	const response = await authStateFetch(c.env, '/admin/remove-project-member', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		projectId: c.req.param('projectId'),
		userId: c.req.param('userId'),
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Server settings (admin only)
// GET /api/admin/settings
adminRoutes.get('/settings', async (c) => {
	const response = await authStateFetch(c.env, '/get-settings', {});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// PUT /api/admin/settings  { registrationOpen?: boolean }
adminRoutes.put('/settings', async (c) => {
	const body = await adminBody(c);
	if (body instanceof Response) return body;
	const response = await authStateFetch(c.env, '/set-settings', {
		requestingUserId: auth(c).user.id,
		requestingUserRole: auth(c).user.role,
		registrationOpen: body.registrationOpen,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

// Keyset-paginated audit entries, newest first
// GET /api/admin/audit?limit=&cursor=
adminRoutes.get('/audit', async (c) => {
	const limitParam = c.req.query('limit');
	const parsedLimit = limitParam === undefined ? undefined : Number(limitParam);
	const response = await authStateFetch(c.env, '/admin/list-audit', {
		requestingUserRole: auth(c).user.role,
		limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
		cursor: c.req.query('cursor') || undefined,
	});
	const data = await response.json();
	return c.json(data, response.status as ContentfulStatusCode);
});
