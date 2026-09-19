import type { Context } from 'hono';
import type { AuthContext, Env, Project } from '../types';

type Variables = {
	auth?: AuthContext;
};

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Resolve a project slug for the authenticated user and return it with the
 * caller's membership role, or an error Response. Membership is mandatory:
 * AuthState's `get-project` has no unscoped branch, so non-members and
 * cross-project callers get the same 404 without learning whether the slug
 * exists.
 */
export async function getProjectWithAccess(
	c: AppContext,
	slug: string,
): Promise<{ project: Project; memberRole: string } | Response> {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!response.ok) {
		return c.json({ error: 'project_not_found' }, 404);
	}

	return response.json();
}
