import type { Env } from '../types';

/**
 * Purge a deleted project's ProjectState Durable Object so events, source
 * maps, comments and stats do not outlive the deleted project. The DO
 * sweeps the R2 attachment prefix first (saga; retries on its alarm if the
 * sweep cannot finish) and only then wipes its own state; ingests are
 * rejected with 503 while a purge is pending. Under the test
 * fault-injection binding, a `purge-sweep` fault header is forwarded so
 * tests can exercise the sweep-retry path; inert in production.
 *
 * Shared by the owner-delete route (`DELETE /api/projects/:slug`) and the
 * admin delete route (`DELETE /api/admin/projects/:projectId`).
 */
export async function purgeProjectState(
	env: Env,
	projectId: string,
	options: { faultHeader?: string } = {},
): Promise<void> {
	const fault =
		env.ATTACHMENT_FAULT_INJECTION === 'enabled' && options.faultHeader === 'purge-sweep'
			? { fault: 'purge-sweep' as const }
			: {};
	const projectStateId = env.PROJECT_STATE.idFromName(projectId);
	const projectState = env.PROJECT_STATE.get(projectStateId);
	await projectState.fetch(
		new Request('http://internal/purge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId, ...fault }),
		}),
	);
}
