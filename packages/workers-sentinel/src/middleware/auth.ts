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
		const message = token.startsWith('wst_')
			? 'Invalid or expired API token'
			: 'Invalid or expired session';
		return c.json({ error: 'unauthorized', message }, 401);
	}

	const auth = (await response.json()) as AuthContext;
	c.set('auth', auth);

	return next();
});
