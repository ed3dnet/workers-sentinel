import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import router from '../router';
import AdminAudit from '../views/admin/AdminAudit.vue';
import AdminProjects from '../views/admin/AdminProjects.vue';
import AdminSettings from '../views/admin/AdminSettings.vue';
import AdminUsers from '../views/admin/AdminUsers.vue';
import Layout from '../views/Layout.vue';
import ProjectSettings from '../views/ProjectSettings.vue';
import Projects from '../views/Projects.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { MockApiError, mockApi, onDelete, onGet, onPost, onPut, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

const mockAdminUser = {
	id: 'user-2',
	email: 'member@example.com',
	name: 'Member User',
	role: 'member' as const,
	disabled: false,
	mustChangePassword: false,
	lastLoginAt: '2026-02-01T00:00:00Z',
	passkeyCount: 1,
	membershipCount: 2,
	createdAt: '2026-01-01T00:00:00Z',
};

async function mountLayout(options: Parameters<typeof seedAuth>[0] = {}) {
	onGet('/api/projects', () => ({ projects: [] }));
	const { pinia, store } = seedAuth(options);
	store.initialized = true;
	const componentRouter = testRouter();
	await atRoute(componentRouter, '/projects');
	const wrapper = mount(Layout, {
		global: {
			plugins: [pinia, componentRouter],
			stubs: { RouterView: true },
		},
	});
	await flushPromises();
	return wrapper;
}

describe('admin nav hidden for members and password-session admins', () => {
	it('shows no Administration group for a member session', async () => {
		const wrapper = await mountLayout({ role: 'member', sessionAuthMethod: 'password' });
		expect(wrapper.find('[data-testid="admin-nav"]').exists()).toBe(false);
	});

	it('shows no Administration group for an admin password session', async () => {
		const wrapper = await mountLayout({ role: 'admin', sessionAuthMethod: 'password' });
		expect(wrapper.find('[data-testid="admin-nav"]').exists()).toBe(false);
	});

	it('shows the Administration group only for an admin passkey session', async () => {
		const wrapper = await mountLayout({
			role: 'admin',
			sessionAuthMethod: 'passkey',
			hasPasskey: true,
		});
		const nav = wrapper.find('[data-testid="admin-nav"]');
		expect(nav.exists()).toBe(true);
		const links = nav.findAll('a').map((a) => a.attributes('href'));
		expect(links).toEqual(
			expect.arrayContaining([
				'/admin/users',
				'/admin/projects',
				'/admin/settings',
				'/admin/audit',
			]),
		);
	});
});

describe('admin routes redirect without a passkey session', () => {
	it('redirects /admin/* to /projects for password-session admins and admits passkey sessions', async () => {
		// Use the real router (its guard is the code under test)
		const { pinia, store } = seedAuth({ role: 'admin', sessionAuthMethod: 'password' });
		store.initialized = true;
		expect(router.currentRoute.value.path).not.toBe('/admin/users');

		await router.push('/admin/users');
		await router.isReady();
		expect(router.currentRoute.value.path).toBe('/projects');

		// Same admin, now on a passkey session: the route is reachable
		const passkey = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		passkey.store.initialized = true;
		onGet('/api/admin/users', () => ({ users: [mockAdminUser] }));
		await router.push('/admin/users');
		await router.isReady();
		await flushPromises();
		expect(router.currentRoute.value.path).toBe('/admin/users');
		void pinia;
	});
});

describe('force password change blocks the app until changed then logs out', () => {
	it('replaces all app content with the blocking screen', async () => {
		const wrapper = await mountLayout({ mustChangePassword: true });
		expect(wrapper.find('[data-testid="force-password-change"]').exists()).toBe(true);
		// The sidebar/main app is not rendered while blocked
		expect(wrapper.find('aside').exists()).toBe(false);
		expect(wrapper.find('[data-testid="user-widget-settings-link"]').exists()).toBe(false);
	});

	it('validates locally and submits the change, then logs out', async () => {
		onPost('/api/auth/change-password', () => ({ success: true }));
		onPost('/api/auth/logout', () => ({ success: true }));
		onGet('/api/projects', () => ({ projects: [] }));

		const { pinia, store } = seedAuth({ mustChangePassword: true });
		store.initialized = true;
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/projects');
		const wrapper = mount(Layout, {
			global: { plugins: [pinia, componentRouter], stubs: { RouterView: true } },
		});
		await flushPromises();

		await wrapper.find('[data-testid="force-password-current"]').setValue('temppassword');
		await wrapper.find('[data-testid="force-password-new"]').setValue('newpassword123');
		await wrapper.find('[data-testid="force-password-confirm"]').setValue('different123');
		await wrapper.find('[data-testid="force-password-submit"]').trigger('submit');
		await flushPromises();
		// Mismatched confirmation: local error, nothing sent
		expect(wrapper.find('[data-testid="force-password-error"]').text()).toContain('do not match');
		expect(mockApi.calls.filter((call) => call.url === '/api/auth/change-password')).toHaveLength(
			0,
		);

		await wrapper.find('[data-testid="force-password-confirm"]').setValue('newpassword123');
		await wrapper.find('[data-testid="force-password-submit"]').trigger('submit');
		await flushPromises();

		// The change was sent and the (now revoked) session cleared
		expect(mockApi.calls.filter((call) => call.url === '/api/auth/change-password')).toHaveLength(
			1,
		);
		expect(mockApi.calls.find((call) => call.url === '/api/auth/change-password')?.body).toEqual({
			currentPassword: 'temppassword',
			newPassword: 'newpassword123',
		});
		expect(store.token).toBeNull();
		expect(localStorage.getItem('token')).toBeNull();
		// Blocking screen gone once logged out
		expect(wrapper.find('[data-testid="force-password-change"]').exists()).toBe(false);
	});
});

describe('admin users page creates users with validation and surfaces owned-projects delete block', () => {
	async function mountUsersPage() {
		const { pinia } = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/admin/users');
		const wrapper = mount(AdminUsers, { global: { plugins: [pinia, componentRouter] } });
		await flushPromises();
		return wrapper;
	}

	it('lists users in the admin table', async () => {
		onGet('/api/admin/users', () => ({ users: [mockAdminUser] }));
		const wrapper = await mountUsersPage();
		expect(wrapper.find('[data-testid="admin-users-table"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="admin-user-row-member@example.com"]').exists()).toBe(true);
		const row = wrapper.find('[data-testid="admin-user-row-member@example.com"]');
		expect(row.text()).toContain('Member User');
		expect(row.text()).toContain('member@example.com');
	});

	it('creates users with local validation and the admin checkbox', async () => {
		onGet('/api/admin/users', () => ({ users: [mockAdminUser] }));
		onPost('/api/admin/users', () => ({ user: mockAdminUser }));
		const wrapper = await mountUsersPage();

		await wrapper.find('[data-testid="admin-users-create"]').trigger('click');
		await wrapper.find('[data-testid="admin-create-name"]').setValue('New User');
		await wrapper.find('[data-testid="admin-create-email"]').setValue('new@example.com');
		await wrapper.find('[data-testid="admin-create-password"]').setValue('short');
		await wrapper.find('[data-testid="admin-create-submit"]').trigger('click');
		await flushPromises();
		// Short temporary password: local error, nothing sent
		expect(wrapper.find('[data-testid="admin-create-error"]').text()).toContain('at least 8');
		expect(
			mockApi.calls.filter((call) => call.method === 'post' && call.url === '/api/admin/users'),
		).toHaveLength(0);

		await wrapper.find('[data-testid="admin-create-password"]').setValue('temppassword123');
		await wrapper.find('[data-testid="admin-create-submit"]').trigger('click');
		await flushPromises();
		expect(
			mockApi.calls.filter((call) => call.method === 'post' && call.url === '/api/admin/users'),
		).toHaveLength(1);
		expect(
			mockApi.calls.find((call) => call.method === 'post' && call.url === '/api/admin/users')?.body,
		).toEqual({
			name: 'New User',
			email: 'new@example.com',
			password: 'temppassword123',
			role: 'member',
		});

		// The admin checkbox switches the assigned role
		await wrapper.find('[data-testid="admin-users-create"]').trigger('click');
		await wrapper.find('[data-testid="admin-create-name"]').setValue('Admin User');
		await wrapper.find('[data-testid="admin-create-email"]').setValue('admin2@example.com');
		await wrapper.find('[data-testid="admin-create-password"]').setValue('temppassword123');
		await wrapper.find('[data-testid="admin-create-is-admin"]').setValue(true);
		await wrapper.find('[data-testid="admin-create-submit"]').trigger('click');
		await flushPromises();
		const createCalls = mockApi.calls.filter(
			(call) => call.method === 'post' && call.url === '/api/admin/users',
		);
		expect(createCalls).toHaveLength(2);
		expect(createCalls[1]?.body).toMatchObject({ role: 'admin' });
	});

	it('renders the owns_projects delete block with the project list', async () => {
		onGet('/api/admin/users', () => ({ users: [mockAdminUser] }));
		onDelete('/api/admin/users/user-2', () => {
			throw new MockApiError(
				'User owns projects; reassign or delete them first',
				409,
				'owns_projects',
				{
					error: 'owns_projects',
					projects: [{ id: 'p1', name: 'CLI Feedback', slug: 'cli-feedback' }],
				},
			);
		});
		const wrapper = await mountUsersPage();

		await wrapper.find('[data-testid="admin-user-delete-member@example.com"]').trigger('click');
		await wrapper.find('[data-testid="admin-delete-submit"]').trigger('click');
		await flushPromises();

		const blocked = wrapper.find('[data-testid="admin-delete-blocked"]');
		expect(blocked.exists()).toBe(true);
		expect(blocked.text()).toContain('CLI Feedback');
		expect(blocked.text()).toContain('cli-feedback');
		// The delete button is disabled while blocked
		const submit = wrapper.find('[data-testid="admin-delete-submit"]');
		expect(submit.attributes('disabled')).toBeDefined();
	});
});

describe('admin projects page assigns owner at creation and reassigns with old owner demoted', () => {
	const adminProjects = [
		{
			id: 'proj-1',
			name: 'CLI Feedback',
			slug: 'cli-feedback',
			platform: 'javascript',
			publicKey: 'pk123',
			createdAt: '2026-02-01T00:00:00Z',
			owner: { userId: 'user-2', email: 'member@example.com', name: 'Member User' },
			memberCount: 2,
		},
	];

	async function mountProjectsPage() {
		const { pinia } = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/admin/projects');
		const wrapper = mount(AdminProjects, { global: { plugins: [pinia, componentRouter] } });
		await flushPromises();
		return wrapper;
	}

	it('creates a project with an assigned owner and shows the DSN', async () => {
		onGet('/api/admin/projects', () => ({ projects: adminProjects }));
		onGet('/api/admin/users', () => ({
			users: [{ id: 'user-2', email: 'member@example.com', name: 'Member User' }],
		}));
		onPost('/api/admin/projects', () => ({
			project: { ...adminProjects[0], id: 'proj-2' },
			dsn: 'https://pk9@localhost/proj-2',
		}));
		const wrapper = await mountProjectsPage();

		await wrapper.find('[data-testid="admin-projects-create"]').trigger('click');
		await wrapper.find('[data-testid="admin-project-create-name"]').setValue('New Service');
		await wrapper.find('[data-testid="admin-project-create-owner"]').setValue('user-2');
		await wrapper.find('[data-testid="admin-project-create-submit"]').trigger('click');
		await flushPromises();

		expect(
			mockApi.calls.find((call) => call.method === 'post' && call.url === '/api/admin/projects')
				?.body,
		).toEqual({
			name: 'New Service',
			platform: 'javascript',
			ownerId: 'user-2',
		});
		expect(wrapper.find('[data-testid="admin-created-dsn"]').text()).toContain(
			'https://pk9@localhost/proj-2',
		);
	});

	it('reassigns ownership through the owner endpoint', async () => {
		onGet('/api/admin/projects', () => ({ projects: adminProjects }));
		onGet('/api/admin/users', () => ({
			users: [
				{ id: 'user-2', email: 'member@example.com', name: 'Member User' },
				{ id: 'user-3', email: 'other@example.com', name: 'Other User' },
			],
		}));
		onPost('/api/admin/projects/proj-1/owner', () => ({
			project: { id: 'proj-1', name: 'CLI Feedback', slug: 'cli-feedback' },
			owner: { userId: 'user-3', email: 'other@example.com', name: 'Other User' },
			previousOwner: { userId: 'user-2', email: 'member@example.com', name: 'Member User' },
		}));
		const wrapper = await mountProjectsPage();

		await wrapper.find('[data-testid="admin-project-owner-cli-feedback"]').trigger('click');
		await wrapper.find('[data-testid="admin-project-owner-select"]').setValue('user-3');
		await wrapper.find('[data-testid="admin-project-owner-submit"]').trigger('click');
		await flushPromises();

		expect(
			mockApi.calls.find((call) => call.url === '/api/admin/projects/proj-1/owner')?.body,
		).toEqual({
			userId: 'user-3',
		});
	});

	it('project delete requires typing the project name', async () => {
		onGet('/api/admin/projects', () => ({ projects: adminProjects }));
		onGet('/api/admin/users', () => ({ users: [] }));
		onDelete('/api/admin/projects/proj-1', () => ({ success: true }));
		const wrapper = await mountProjectsPage();

		await wrapper.find('[data-testid="admin-project-delete-cli-feedback"]').trigger('click');
		const submit = () => wrapper.find('[data-testid="admin-project-delete-submit"]');
		expect(submit().attributes('disabled')).toBeDefined();

		await wrapper.find('[data-testid="admin-project-delete-confirm"]').setValue('wrong name');
		expect(submit().attributes('disabled')).toBeDefined();

		await wrapper.find('[data-testid="admin-project-delete-confirm"]').setValue('CLI Feedback');
		expect(submit().attributes('disabled')).toBeUndefined();

		await submit().trigger('click');
		await flushPromises();
		expect(mockApi.calls.filter((call) => call.url === '/api/admin/projects/proj-1')).toHaveLength(
			1,
		);
	});
});

describe('audit page lists actions with pagination', () => {
	it('renders entries newest-first and pages with the cursor', async () => {
		const entry = (id: string, action: string) => ({
			id,
			actorEmail: 'dev@example.com',
			actorName: 'Dev User',
			action,
			targetType: 'user',
			targetId: `target-${id}`,
			targetLabel: 'someone@example.com',
			details: { role: 'member' },
			createdAt: '2026-02-01T00:00:00Z',
		});
		let page = 0;
		onGet('/api/admin/audit?limit=25', () => {
			page++;
			if (page === 1) {
				return {
					entries: [entry('a1', 'user.created'), entry('a2', 'user.renamed')],
					nextCursor: 'c1',
					hasMore: true,
				};
			}
			return { entries: [entry('a3', 'project.created')], hasMore: false };
		});
		onGet('/api/admin/audit?limit=25&cursor=c1', () => ({
			entries: [entry('a3', 'project.created')],
			hasMore: false,
		}));

		const { pinia } = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/admin/audit');
		const wrapper = mount(AdminAudit, { global: { plugins: [pinia, componentRouter] } });
		await flushPromises();

		const table = wrapper.find('[data-testid="admin-audit-table"]');
		expect(table.exists()).toBe(true);
		expect(table.text()).toContain('user.created');
		expect(table.text()).toContain('user.renamed');

		await wrapper.find('[data-testid="admin-audit-load-more"]').trigger('click');
		await flushPromises();
		expect(table.text()).toContain('project.created');
		expect(mockApi.calls.filter((call) => call.url.includes('/api/admin/audit'))).toHaveLength(2);
	});
});

describe('project settings shows read-only roster without management controls', () => {
	it('renders the roster with role badges and no management UI', async () => {
		onGet('/api/projects/cli-feedback', () => ({
			project: {
				id: 'proj-1',
				name: 'CLI Feedback',
				slug: 'cli-feedback',
				platform: 'javascript',
				publicKey: 'pk123',
				createdAt: '2026-02-01T00:00:00Z',
			},
			dsn: 'https://pk123@localhost/proj-1',
		}));
		onGet('/api/projects/cli-feedback/settings', () => ({ retentionDays: 0 }));
		onGet('/api/projects/cli-feedback/sourcemaps', () => ({ sourceMaps: [] }));
		onGet('/api/projects/cli-feedback/rate-limit', () => ({
			maxEventsPerHour: 0,
			currentHourCount: 0,
			isLimited: false,
		}));
		onGet('/api/projects/cli-feedback/members', () => ({
			members: [
				{
					userId: 'user-1',
					email: 'dev@example.com',
					name: 'Dev User',
					role: 'owner',
					createdAt: '2026-02-01T00:00:00Z',
				},
				{
					userId: 'user-2',
					email: 'member@example.com',
					name: 'Member User',
					role: 'member',
					createdAt: '2026-02-01T00:00:00Z',
				},
			],
		}));

		const { pinia } = seedAuth({ role: 'member', sessionAuthMethod: 'password' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/projects/cli-feedback/settings');
		const wrapper = mount(ProjectSettings, {
			global: { plugins: [pinia, componentRouter] },
		});
		await flushPromises();
		await flushPromises();

		const text = wrapper.text();
		expect(text).toContain('Dev User');
		expect(text).toContain('Member User');
		expect(text).toContain('Owner');
		// No management controls remain on the roster
		expect(text).not.toContain('Add Member');
		const membersCard = wrapper.findAll('.card').find((c) => c.text().includes('Team Members'));
		expect(membersCard).toBeDefined();
		expect(membersCard?.findAll('select').length).toBe(0);
		expect(membersCard?.findAll('button').length).toBe(0);
		// Points at the centralized administration surface
		expect(membersCard?.text()).toContain('administrators');
	});
});

describe('no project-create affordances remain', () => {
	it('Layout has no /projects/new links for any session type', async () => {
		for (const options of [
			{ role: 'member' as const, sessionAuthMethod: 'password' as const },
			{ role: 'admin' as const, sessionAuthMethod: 'password' as const },
			{ role: 'admin' as const, sessionAuthMethod: 'passkey' as const },
		]) {
			resetMocks();
			const wrapper = await mountLayout(options);
			expect(wrapper.findAll('a[href="/projects/new"]')).toHaveLength(0);
			expect(wrapper.text()).not.toContain('New Project');
		}
	});

	it('Projects page has no create button or link', async () => {
		onGet('/api/projects', () => ({ projects: [] }));
		const { pinia } = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/projects');
		const wrapper = mount(Projects, { global: { plugins: [pinia, componentRouter] } });
		await flushPromises();

		expect(wrapper.findAll('a[href="/projects/new"]')).toHaveLength(0);
		expect(wrapper.text()).not.toContain('New Project');
		expect(wrapper.text()).toContain('administrators');
	});
});

describe('admin settings page toggles registration', () => {
	it('reads the toggle and PUTs the flip', async () => {
		let open = true;
		onGet('/api/admin/settings', () => ({ settings: { registrationOpen: open } }));
		onPut('/api/admin/settings', (body) => {
			open = !open;
			void body;
			return { settings: { registrationOpen: open } };
		});

		const { pinia } = seedAuth({ role: 'admin', sessionAuthMethod: 'passkey' });
		const componentRouter = testRouter();
		await atRoute(componentRouter, '/admin/settings');
		const wrapper = mount(AdminSettings, {
			global: { plugins: [pinia, componentRouter] },
		});
		await flushPromises();

		expect(wrapper.find('[data-testid="admin-settings-registration-state"]').text()).toBe('Open');
		await wrapper.find('[data-testid="admin-settings-registration-toggle"]').trigger('click');
		await flushPromises();
		expect(
			mockApi.calls.find((call) => call.url === '/api/admin/settings' && call.method === 'put')
				?.body,
		).toEqual({ registrationOpen: false });
		expect(wrapper.find('[data-testid="admin-settings-registration-state"]').text()).toBe('Closed');
	});
});
