import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import Layout from '../views/Layout.vue';
import Settings from '../views/Settings.vue';
import { atRoute, mockPasskeyCeremony, seedAuth, testRouter } from './helpers';
import { MockApiError, mockApi, onGet, onPatch, onPost, startRegistration } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

describe('settings security pane changes password and forces logout', () => {
	it('clears the token and routes to /login on success', async () => {
		onPost('/api/auth/change-password', () => ({ success: true }));
		onPost('/api/auth/logout', () => ({ success: true }));

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings?tab=security');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });

		await wrapper.find('#current-password').setValue('old-password-1');
		await wrapper.find('#new-password').setValue('new-password-1');
		await wrapper.find('#confirm-password').setValue('new-password-1');
		await wrapper.find('[data-testid="change-password-submit"]').trigger('submit');
		await flushPromises();

		const call = mockApi.calls.find((c) => c.url === '/api/auth/change-password');
		expect(call?.body).toEqual({
			currentPassword: 'old-password-1',
			newPassword: 'new-password-1',
		});

		const store = useAuthStore(pinia);
		expect(store.isAuthenticated).toBe(false);
		expect(router.currentRoute.value.path).toBe('/login');
	});

	it('stays on the page with an error on failure', async () => {
		onPost('/api/auth/change-password', () => {
			throw new MockApiError('Current password is incorrect', 401, 'invalid_credentials');
		});

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings?tab=security');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });

		await wrapper.find('#current-password').setValue('wrong-password');
		await wrapper.find('#new-password').setValue('new-password-1');
		await wrapper.find('#confirm-password').setValue('new-password-1');
		await wrapper.find('[data-testid="change-password-submit"]').trigger('submit');
		await flushPromises();

		expect(wrapper.text()).toContain('Current password is incorrect');
		const store = useAuthStore(pinia);
		expect(store.isAuthenticated).toBe(true);
		expect(router.currentRoute.value.path).toBe('/settings');
	});
});

describe('settings lists adds and deletes passkeys with required names', () => {
	beforeEach(() => {
		mockPasskeyCeremony();
		startRegistration.mockResolvedValue({ id: 'cred-2' });
	});

	it('renders the credential list with names and dates', async () => {
		onGet('/api/auth/webauthn/credentials', () => ({
			credentials: [
				{
					id: 'cred-1',
					name: 'YubiKey 5C',
					createdAt: '2026-01-01T10:00:00Z',
					lastUsedAt: '2026-02-01T10:00:00Z',
				},
				{ id: 'cred-2', name: 'iPhone', createdAt: '2026-03-01T10:00:00Z', lastUsedAt: null },
			],
		}));

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings?tab=security');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });
		await flushPromises();

		const pane = wrapper.find('[data-testid="settings-passkeys"]');
		expect(pane.exists()).toBe(true);
		expect(pane.text()).toContain('YubiKey 5C');
		expect(pane.text()).toContain('iPhone');
		expect(pane.text()).toContain('Never');
	});

	it('blocks adding without a name; adds with one; delete updates the list', async () => {
		let credentials = [
			{ id: 'cred-1', name: 'YubiKey 5C', createdAt: '2026-01-01T10:00:00Z', lastUsedAt: null },
		];
		onGet('/api/auth/webauthn/credentials', () => ({ credentials: [...credentials] }));
		onPost('/api/auth/webauthn/credentials/delete', (body) => {
			expect((body as { credentialId: string }).credentialId).toBe('cred-1');
			credentials = [];
			return { success: true };
		});

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings?tab=security');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });
		await flushPromises();

		// Blank name is blocked client-side
		await wrapper.find('[data-testid="add-passkey-button"]').trigger('submit');
		await flushPromises();
		expect(startRegistration).not.toHaveBeenCalled();

		// Adding with a name runs the full ceremony
		await wrapper.find('[data-testid="new-passkey-name"]').setValue('Backup Key');
		await wrapper.find('[data-testid="add-passkey-button"]').trigger('submit');
		await flushPromises();
		expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: {} });
		const verifyCall = mockApi.calls.find((c) => c.url === '/api/auth/webauthn/verify/register');
		expect(verifyCall?.body).toMatchObject({ ceremonyId: 'cer-reg-1', name: 'Backup Key' });

		// Deleting the last passkey warns it is the last one
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const deleteButtons = wrapper.findAll('button').filter((b) => b.text() === 'Delete');
		await deleteButtons[0].trigger('click');
		await flushPromises();
		expect(confirmSpy.mock.calls[0][0]).toContain('last passkey');
		expect(
			mockApi.calls.some(
				(c) => c.method === 'post' && c.url === '/api/auth/webauthn/credentials/delete',
			),
		).toBe(true);

		const store = useAuthStore(pinia);
		expect(store.hasPasskey).toBe(false);
		confirmSpy.mockRestore();
	});
});

describe('settings general pane edits the profile', () => {
	it('profile form saves and updates the signed-in display', async () => {
		onPatch('/api/auth/profile', (body) => {
			expect(body).toEqual({ name: 'New Display Name', email: 'new@example.com' });
			return {
				user: {
					id: 'user-1',
					email: 'new@example.com',
					name: 'New Display Name',
					role: 'member',
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-02-02T00:00:00Z',
				},
			};
		});

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });
		await flushPromises();

		const pane = wrapper.find('[data-testid="settings-general"]');
		expect(pane.exists()).toBe(true);

		// The form renders prefilled from the store
		const nameInput = wrapper.find('[data-testid="profile-name-input"]');
		const emailInput = wrapper.find('[data-testid="profile-email-input"]');
		expect((nameInput.element as HTMLInputElement).value).toBe('Dev User');
		expect((emailInput.element as HTMLInputElement).value).toBe('dev@example.com');

		// Save is disabled until a value differs from the store
		const save = wrapper.find('[data-testid="profile-save"]');
		expect(save.attributes('disabled')).toBeDefined();

		await nameInput.setValue('New Display Name');
		await emailInput.setValue('new@example.com');
		expect(save.attributes('disabled')).toBeUndefined();

		await save.trigger('submit');
		await flushPromises();

		// The PATCH carried the new values
		const call = mockApi.calls.find((c) => c.method === 'patch' && c.url === '/api/auth/profile');
		expect(call?.body).toEqual({ name: 'New Display Name', email: 'new@example.com' });

		// The store's user updates and the success note shows
		const store = useAuthStore(pinia);
		expect(store.user?.name).toBe('New Display Name');
		expect(store.user?.email).toBe('new@example.com');
		expect(wrapper.find('[data-testid="profile-success"]').text()).toContain('Profile updated');

		// A Layout mounted with the same pinia renders the new name/email
		// in the sidebar's signed-in display
		onGet('/api/projects', () => ({ projects: [] }));
		const layoutRouter = testRouter();
		await atRoute(layoutRouter, '/settings');
		const layout = mount(Layout, {
			global: { plugins: [pinia, layoutRouter], stubs: { RouterView: true } },
		});
		await flushPromises();
		expect(layout.text()).toContain('New Display Name');
		expect(layout.text()).toContain('new@example.com');
	});

	it('profile form surfaces save errors', async () => {
		onPatch('/api/auth/profile', () => {
			throw new MockApiError('Another user already uses that email', 409, 'email_in_use');
		});

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await atRoute(router, '/settings');
		const wrapper = mount(Settings, { global: { plugins: [pinia, router] } });
		await flushPromises();

		await wrapper.find('[data-testid="profile-email-input"]').setValue('taken@example.com');
		await wrapper.find('[data-testid="profile-save"]').trigger('submit');
		await flushPromises();

		const error = wrapper.find('[data-testid="profile-error"]');
		expect(error.exists()).toBe(true);
		expect(error.text()).toContain('Another user already uses that email');
		expect(wrapper.find('[data-testid="profile-success"]').exists()).toBe(false);
		const store = useAuthStore(pinia);
		expect(store.user?.email).toBe('dev@example.com');
	});
});
