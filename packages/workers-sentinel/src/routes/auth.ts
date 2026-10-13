import { Hono } from 'hono';
import { invalidJsonBody } from '../lib/capped-json';
import { extractBearerToken } from '../middleware/auth';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

export const authRoutes = new Hono<{ Bindings: Env }>();
export const tokenRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Register a new user
authRoutes.post('/register', async (c) => {
	const body = await c.req.json<{
		email: string;
		password: string;
		name: string;
		setupToken?: string;
	}>();

	if (!body.email || !body.password || !body.name) {
		return c.json(
			{ error: 'missing_fields', message: 'Email, password, and name are required' },
			400,
		);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...body,
				ip: c.req.header('CF-Connecting-IP') ?? undefined,
			}),
		}),
	);

	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 403 | 409 | 429);
});

// Login
authRoutes.post('/login', async (c) => {
	const body = await c.req.json<{ email: string; password: string }>();

	if (!body.email || !body.password) {
		return c.json({ error: 'missing_fields', message: 'Email and password are required' }, 400);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);

	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 401);
});

// Logout: invalidate the presented session
authRoutes.post('/logout', async (c) => {
	const token = extractBearerToken(c.req.header('Authorization'));

	if (!token) {
		return c.json({ success: true });
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	await authState.fetch(
		new Request('http://internal/logout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
		}),
	);

	return c.json({ success: true });
});

// Logout-all: invalidate every session for the authenticated user (session auth only)
authRoutes.post('/logout-all', async (c) => {
	const token = extractBearerToken(c.req.header('Authorization'));
	if (!token || token.startsWith('wst_')) {
		return c.json({ error: 'unauthorized', message: 'Session authentication required' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/validate-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
		}),
	);
	if (!response.ok) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
	}
	const { user } = (await response.json()) as { user: { id: string } };

	await authState.fetch(
		new Request('http://internal/logout-all', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: user.id }),
		}),
	);

	return c.json({ success: true });
});

// Change password (requires the current password; revokes all sessions)
authRoutes.post('/change-password', async (c) => {
	const token = extractBearerToken(c.req.header('Authorization'));
	if (!token || token.startsWith('wst_')) {
		return c.json({ error: 'unauthorized', message: 'Session authentication required' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);
	const response = await authState.fetch(
		new Request('http://internal/validate-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
		}),
	);
	if (!response.ok) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
	}
	const { user } = (await response.json()) as { user: { id: string } };

	const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>();
	const change = await authState.fetch(
		new Request('http://internal/change-password', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				userId: user.id,
				currentPassword: body.currentPassword,
				newPassword: body.newPassword,
			}),
		}),
	);
	const data = await change.json();
	return c.json(data, change.status as 200 | 400 | 401 | 404);
});

// Update the signed-in user's own profile (display name / email).
// Session-only: API tokens are rejected (they must not change the login
// identity of the account that minted them), and a forced-password-change
// flagged session gets recovery paths only — this is not one of them.
authRoutes.patch('/profile', async (c) => {
	const token = extractBearerToken(c.req.header('Authorization'));
	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Missing authorization header' }, 401);
	}
	if (token.startsWith('wst_')) {
		return c.json(
			{ error: 'session_required', message: 'Profile updates require session authentication' },
			403,
		);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);
	const response = await authState.fetch(
		new Request('http://internal/validate-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
		}),
	);
	if (!response.ok) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
	}
	const { user, mustChangePassword } = (await response.json()) as {
		user: { id: string };
		mustChangePassword: boolean;
	};
	if (mustChangePassword) {
		return c.json({ error: 'password_change_required' }, 403);
	}

	// Plain parse with an object guard (no readCappedJson here by design:
	// this route's body is tiny and uncapped like register/login, and a
	// capped reader's cancel paths would run after the validate-session
	// subrequest — the documented workerd body-cancel trap). Malformed or
	// non-object bodies answer 400 invalid_json, the shared vocabulary.
	let parsed: unknown;
	try {
		parsed = await c.req.json();
	} catch {
		return c.json(invalidJsonBody, 400);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return c.json(invalidJsonBody, 400);
	}
	const body = parsed as { name?: string; email?: string };
	const update = await authState.fetch(
		new Request('http://internal/update-profile', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// Explicit field whitelist: the acting identity comes from the
			// validated session, never from the request body.
			body: JSON.stringify({ userId: user.id, name: body.name, email: body.email }),
		}),
	);
	const data = await update.json();
	return c.json(data, update.status as 200 | 400 | 404 | 409 | 500);
});

// Get current user
authRoutes.get('/me', async (c) => {
	const token = extractBearerToken(c.req.header('Authorization'));

	if (!token) {
		return c.json({ error: 'unauthorized', message: 'Missing authorization header' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/validate-session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token }),
		}),
	);

	if (!response.ok) {
		return c.json({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
	}

	const data = await response.json();
	return c.json(data);
});

// API Token routes (require session auth - managed via authMiddleware applied in index.ts)

// Session-only guard: API tokens cannot manage API tokens
tokenRoutes.use('*', async (c, next) => {
	// Same tolerant parser as authMiddleware (case-insensitive scheme,
	// whitespace-trimmed) — a fixed substring(7) would miss "Bearer  wst_…"
	// and let an API token slip past this guard.
	const token = extractBearerToken(c.req.header('Authorization'));
	if (token?.startsWith('wst_')) {
		return c.json(
			{
				error: 'forbidden',
				message: 'API token management requires session authentication',
			},
			403,
		);
	}
	return next();
});

// List current user's API tokens
tokenRoutes.get('/', async (c) => {
	const auth = c.get('auth') as AuthContext;
	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/list-api-tokens', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: auth.user.id }),
		}),
	);

	const data = await response.json();
	return c.json(data, response.status as 200);
});

// Create a new API token
tokenRoutes.post('/', async (c) => {
	const auth = c.get('auth') as AuthContext;
	const body = await c.req.json<{ name: string; expiresAt?: string }>();

	if (!body.name) {
		return c.json({ error: 'missing_fields', message: 'Token name is required' }, 400);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/create-api-token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				userId: auth.user.id,
				name: body.name,
				expiresAt: body.expiresAt,
			}),
		}),
	);

	const data = await response.json();
	return c.json(data, response.status as 200 | 400);
});

// Revoke an API token
tokenRoutes.delete('/:tokenId', async (c) => {
	const auth = c.get('auth') as AuthContext;
	const tokenId = c.req.param('tokenId');

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/revoke-api-token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tokenId, userId: auth.user.id }),
		}),
	);

	const data = await response.json();
	return c.json(data, response.status as 200 | 404);
});
