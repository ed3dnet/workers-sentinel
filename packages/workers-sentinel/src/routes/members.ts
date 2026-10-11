import { type Context, Hono } from 'hono';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// Membership management is centralized under /api/admin/projects/:id/members
// (admin-only). This router keeps the read-only roster for project members.
export const memberRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Helper to get project and check member role
async function getProjectAndRole(
	c: AppContext,
	slug: string,
): Promise<{ projectId: string; role: string } | Response> {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	// Resolve slug to project
	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!getResponse.ok) {
		return c.json({ error: 'project_not_found' }, 404);
	}

	const projectData = (await getResponse.json()) as { project: { id: string } };

	// Check access and get role
	const accessResponse = await authState.fetch(
		new Request('http://internal/check-access', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: projectData.project.id, userId: auth.user.id }),
		}),
	);

	const accessData = (await accessResponse.json()) as {
		hasAccess: boolean;
		role: string | null;
	};

	if (!accessData.hasAccess) {
		return c.json({ error: 'forbidden' }, 403);
	}

	return { projectId: projectData.project.id, role: accessData.role! };
}

// List all members of a project (read-only; management lives in /api/admin)
// GET /api/projects/:slug/members
memberRoutes.get('/:slug/members', async (c) => {
	const slug = c.req.param('slug');
	const result = await getProjectAndRole(c, slug);

	if (result instanceof Response) {
		return result;
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/list-project-members', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: result.projectId }),
		}),
	);

	const data = await response.json();
	return c.json(data);
});
