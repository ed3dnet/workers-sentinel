import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PasskeyNag from '../components/PasskeyNag.vue';
import { mockPasskeyCeremony, seedAuth } from './helpers';
import { onPost, startRegistration } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

describe('passkey nag appears without passkey and hides after registering', () => {
	beforeEach(() => {
		mockPasskeyCeremony();
	});

	it('is visible only for authenticated users without a passkey', () => {
		const { pinia } = seedAuth({ hasPasskey: false });
		const wrapper = mount(PasskeyNag, { global: { plugins: [pinia] } });
		expect(wrapper.find('[data-testid="passkey-nag"]').exists()).toBe(true);

		const withPasskey = seedAuth({ hasPasskey: true });
		const hidden = mount(PasskeyNag, { global: { plugins: [withPasskey.pinia] } });
		expect(hidden.find('[data-testid="passkey-nag"]').exists()).toBe(false);

		const anonymous = seedAuth({ authenticated: false });
		const loggedOut = mount(PasskeyNag, { global: { plugins: [anonymous.pinia] } });
		expect(loggedOut.find('[data-testid="passkey-nag"]').exists()).toBe(false);
	});

	it('hides after successful registration flips hasPasskey', async () => {
		startRegistration.mockResolvedValue({ id: 'cred-1' });
		const { pinia, store } = seedAuth({ hasPasskey: false });
		const wrapper = mount(PasskeyNag, { global: { plugins: [pinia] } });

		await wrapper.find('[data-testid="passkey-name-input"]').setValue('YubiKey 5C');
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(store.hasPasskey).toBe(true);
		expect(wrapper.find('[data-testid="passkey-nag"]').exists()).toBe(false);
	});

	it('requires a name before starting the ceremony', async () => {
		const { pinia } = seedAuth({ hasPasskey: false });
		const wrapper = mount(PasskeyNag, { global: { plugins: [pinia] } });

		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(startRegistration).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="passkey-nag"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Give the passkey a name first');
	});
});

describe('passkey nag dismissal is per-visit only', () => {
	beforeEach(() => {
		mockPasskeyCeremony();
	});

	it('stays hidden after dismissal but re-appears after a reload (store re-initialization)', () => {
		const first = seedAuth({ hasPasskey: false });
		const wrapper = mount(PasskeyNag, { global: { plugins: [first.pinia] } });
		expect(wrapper.find('[data-testid="passkey-nag"]').exists()).toBe(true);

		// Nothing persisted: a page reload builds a fresh store with the
		// in-memory dismissal gone
		expect(localStorage.getItem('passkey-nag-dismissed')).toBeNull();

		const reloaded = seedAuth({ hasPasskey: false });
		const again = mount(PasskeyNag, { global: { plugins: [reloaded.pinia] } });
		expect(again.find('[data-testid="passkey-nag"]').exists()).toBe(true);
	});

	it('re-prompts after logout and a fresh password login', async () => {
		onPost('/api/auth/logout', () => ({ success: true }));
		onPost('/api/auth/login', () => ({
			user: {
				id: 'user-2',
				email: 'other@example.com',
				name: 'Other User',
				role: 'member',
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
			},
			token: 'new-token',
			hasPasskey: false,
		}));

		const { pinia, store } = seedAuth({ hasPasskey: false });
		const wrapper = mount(PasskeyNag, { global: { plugins: [pinia] } });
		await wrapper.find('[data-testid="passkey-nag-dismiss"]').trigger('click');
		expect(wrapper.find('[data-testid="passkey-nag"]').exists()).toBe(false);

		// Log out, then sign in as a different user: prompted fresh
		await store.logout();
		expect(store.dismissedForThisVisit).toBe(false);
		const ok = await store.login('other@example.com', 'whatever1');
		expect(ok).toBe(true);
		expect(store.isAuthenticated).toBe(true);
		expect(store.dismissedForThisVisit).toBe(false);

		const rePrompted = mount(PasskeyNag, { global: { plugins: [pinia] } });
		expect(rePrompted.find('[data-testid="passkey-nag"]').exists()).toBe(true);
	});
});
