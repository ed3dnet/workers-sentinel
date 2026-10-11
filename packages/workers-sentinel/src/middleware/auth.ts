import { createMiddleware } from 'hono/factory';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

/** Case-insensitive Bearer scheme extraction with trimming. */
export function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const match = /^\s*bearer\s+(.+)$/i.exec(header);
	return match ? match[1].trim() : null;
}

export const authMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const token = extractBearerToken(c.req.header('Authorization'));

	if (!token) {
		return c.json(
			{ error: 'unauthorized', message: 'Missing or invalid authorization header' },
			401,
		);
	}

	// Get the singleton AuthState Durable Object
	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	// Choose validation endpoint based on token prefix
	let response: Response;
	if (token.startsWith('wst_')) {
		// API token auth
		response = await authState.fetch(
			new Request('http://internal/validate-api-token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token }),
			}),
		);
	} else {
		// Session token auth (existing behavior)
		response = await authState.fetch(
			new Request('http://internal/validate-session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token }),
			}),
		);
	}

	if (!response.ok) {
		// Surface the forced-password-change token rejection verbatim (401
		// password_change_required); every other failure stays the generic
		// unauthorized response.
		let detail: { error?: string; message?: string } | null = null;
		try {
			detail = (await response.json()) as { error?: string; message?: string };
		} catch {
			detail = null;
		}
		if (detail?.error === 'password_change_required') {
			return c.json({ error: 'password_change_required' }, 401);
		}
		const message = token.startsWith('wst_')
			? 'Invalid or expired API token'
			: 'Invalid or expired session';
		return c.json({ error: 'unauthorized', message }, 401);
	}

	const auth = (await response.json()) as AuthContext;

	// Server-side forced-password-change enforcement: a temp-password
	// session may only reach the recovery paths (/api/auth/me,
	// change-password, logout, logout-all — all outside this middleware).
	// Everything it guards — /api/projects/*, tokens, passkey register/
	// manage, /api/admin/*, /api/0/* — is off-limits until the change lands.
	// The body carries only the machine-checkable error code so every
	// surface (native and the /api/0 {detail} translator) reports it
	// uniformly.
	if (auth.mustChangePassword) {
		return c.json({ error: 'password_change_required' }, 403);
	}

	c.set('auth', auth);

	return next();
});
