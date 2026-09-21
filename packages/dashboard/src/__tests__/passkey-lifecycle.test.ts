import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PasskeyNag from '../components/PasskeyNag.vue';
import { mockPasskeyCeremony, seedAuth } from './helpers';
import { onGet, onPost, startRegistration } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

describe('deleting the last passkey reopens the nag without a reload', () => {
	beforeEach(() => {
		mockPasskeyCeremony();
		startRegistration.mockResolvedValue({ id: 'cred-1' });
	});

	it('dismiss → add via Settings → delete last → nag visible again in the same visit', async () => {
		let credentials = [
			{ id: 'cred-1', name: 'Test Key', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null },
		];
		onGet('/api/auth/webauthn/credentials', () => ({ credentials: [...credentials] }));
		onPost('/api/auth/webauthn/credentials/delete', () => {
			credentials = [];
			return { success: true };
		});

		const { pinia, store } = seedAuth({ hasPasskey: false });

		// The user dismissed the nag earlier in this visit
		store.dismissPasskeyNag();
		let nag = mount(PasskeyNag, { global: { plugins: [pinia] } });
		expect(nag.find('[data-testid="passkey-nag"]').exists()).toBe(false);

		// Then added a passkey from Settings (the nag condition is gone)
		await store.registerPasskey('Test Key');
		expect(store.hasPasskey).toBe(true);
		nag = mount(PasskeyNag, { global: { plugins: [pinia] } });
		expect(nag.find('[data-testid="passkey-nag"]').exists()).toBe(false);

		// Deleting the last passkey re-arms the nag immediately — the
		// in-memory dismissal was reset, no reload involved
		await store.deletePasskey('cred-1');
		await flushPromises();
		expect(store.hasPasskey).toBe(false);
		expect(store.dismissedForThisVisit).toBe(false);
		nag = mount(PasskeyNag, { global: { plugins: [pinia] } });
		expect(nag.find('[data-testid="passkey-nag"]').exists()).toBe(true);
	});
});
