import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import Login from '../views/Login.vue';
import { atRoute, mockPasskeyCeremony, seedAuth, testRouter } from './helpers';
import { mockApi, onPost, startAuthentication } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

describe('login page offers single-step passkey sign-in', () => {
	beforeEach(() => {
		mockPasskeyCeremony();
	});

	it('signs in with a passkey without any email input', async () => {
		startAuthentication.mockResolvedValue({ id: 'cred-1', response: {} });
		const { pinia } = seedAuth({ authenticated: false });
		const router = testRouter();
		await atRoute(router, '/login');

		const wrapper = mount(Login, { global: { plugins: [pinia, router] } });
		const button = wrapper.find('[data-testid="passkey-login-button"]');
		expect(button.exists()).toBe(true);
		expect(button.text()).toContain('Sign in with a passkey');

		await button.trigger('click');
		await flushPromises();

		// Usernameless: the options call carried no email, the verify call
		// carried the ceremony id and the browser ceremony response
		const optionsCall = mockApi.calls.find(
			(call) => call.method === 'post' && call.url === '/api/auth/webauthn/login/options',
		);
		expect(optionsCall?.body).toEqual({});
		expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: {} });
		const verifyCall = mockApi.calls.find(
			(call) => call.method === 'post' && call.url === '/api/auth/webauthn/verify/login',
		);
		expect(verifyCall?.body).toEqual({
			ceremonyId: 'cer-login-1',
			response: { id: 'cred-1', response: {} },
		});

		const store = useAuthStore(pinia);
		expect(store.isAuthenticated).toBe(true);
		expect(store.hasPasskey).toBe(true);
		expect(router.currentRoute.value.path).toBe('/');
	});

	it('shows the friendly no-credential message on ceremony failure', async () => {
		const cancelled = new Error('The operation either timed out or was not allowed.');
		cancelled.name = 'NotAllowedError';
		startAuthentication.mockRejectedValue(cancelled);

		const { pinia } = seedAuth({ authenticated: false });
		const router = testRouter();
		await atRoute(router, '/login');

		const wrapper = mount(Login, { global: { plugins: [pinia, router] } });
		await wrapper.find('[data-testid="passkey-login-button"]').trigger('click');
		await flushPromises();

		const error = wrapper.find('[data-testid="passkey-login-error"]');
		expect(error.exists()).toBe(true);
		expect(error.text()).toContain('No passkey found for this site');

		const store = useAuthStore(pinia);
		expect(store.isAuthenticated).toBe(false);
	});

	it('accepts format-free identifiers — the email input is type="text"', async () => {
		onPost('/api/auth/login', () => ({
			user: {
				id: 'user-1',
				email: 'no-at-identifier',
				name: 'Dev User',
				role: 'member',
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
			},
			token: 'fresh-session-token',
			hasPasskey: true,
		}));

		const { pinia } = seedAuth({ authenticated: false });
		const router = testRouter();
		await atRoute(router, '/login');

		const wrapper = mount(Login, { global: { plugins: [pinia, router] } });

		// Assert the configuration itself: programmatic form.submit()
		// bypasses browser constraint validation, so a type="email" input
		// (which would block format-free identifiers the profile endpoint
		// deliberately accepts) has to be caught by its attribute
		const emailInput = wrapper.find('#email');
		expect(emailInput.attributes('type')).toBe('text');
		expect(emailInput.attributes('autocomplete')).toBe('username');

		// And the login request goes through with an @-less value
		await emailInput.setValue('no-at-identifier');
		await wrapper.find('#password').setValue('testpassword123');
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		const loginCall = mockApi.calls.find(
			(call) => call.method === 'post' && call.url === '/api/auth/login',
		);
		expect(loginCall?.body).toEqual({
			email: 'no-at-identifier',
			password: 'testpassword123',
		});

		const store = useAuthStore(pinia);
		expect(store.isAuthenticated).toBe(true);
		expect(router.currentRoute.value.path).toBe('/');
	});
});
