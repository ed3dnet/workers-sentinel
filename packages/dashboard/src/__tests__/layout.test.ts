import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import Layout from '../views/Layout.vue';
import { seedAuth, testRouter } from './helpers';
import { onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

describe('sidebar user widget links to settings', () => {
	it('wraps the user identity in a link to /settings', async () => {
		onGet('/api/projects', () => ({ projects: [] }));

		const { pinia } = seedAuth({ hasPasskey: true });
		const router = testRouter();
		await router.push('/projects');
		await router.isReady();

		const wrapper = mount(Layout, {
			global: {
				plugins: [pinia, router],
				stubs: { RouterView: true },
			},
		});
		await flushPromises();

		const link = wrapper.find('[data-testid="user-widget-settings-link"]');
		expect(link.exists()).toBe(true);
		expect(link.attributes('href')).toBe('/settings');
		expect(link.text()).toContain('Dev User');
		expect(link.text()).toContain('dev@example.com');
	});
});
