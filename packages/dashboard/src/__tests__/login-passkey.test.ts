import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import Login from '../views/Login.vue';
import { atRoute, mockPasskeyCeremony, seedAuth, testRouter } from './helpers';
import { mockApi, startAuthentication } from './mocks';

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
});
