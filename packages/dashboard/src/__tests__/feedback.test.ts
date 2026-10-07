import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Feedback from '../views/Feedback.vue';
import FeedbackDetail from '../views/FeedbackDetail.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { mockApi, onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

type FeedbackItem = {
	id: string;
	description: string;
	pageUrl: string | null;
	pageTitle: string | null;
	locator: unknown;
	geometry: unknown;
	receivedAt: string;
	screenshotType: string | null;
	screenshotSize: number | null;
};

const item: FeedbackItem = {
	id: 'feedback-1',
	description: 'The save button is hard to find',
	pageUrl: 'https://example.com/settings',
	pageTitle: 'Settings',
	locator: { selector: '#save' },
	geometry: { x: 12, y: 24, width: 50, height: 20 },
	receivedAt: '2026-03-01T12:00:00.000Z',
	screenshotType: null,
	screenshotSize: null,
};

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalCreateObjectURL) {
		Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
	} else {
		Reflect.deleteProperty(URL, 'createObjectURL');
	}
	if (originalRevokeObjectURL) {
		Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
	} else {
		Reflect.deleteProperty(URL, 'revokeObjectURL');
	}
});

describe('feedback inbox', () => {
	it('loads feedback and appends the cursor page', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({
			feedback: [item],
			nextCursor: 'cursor-2',
			hasMore: true,
		}));
		onGet('/api/projects/demo/feedback?limit=25&cursor=cursor-2', () => ({
			feedback: [{ ...item, id: 'feedback-2', description: 'A second report' }],
			hasMore: false,
		}));

		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();

		expect(wrapper.text()).toContain('The save button is hard to find');
		expect(wrapper.find('a[href="/projects/demo/feedback/feedback-1"]').exists()).toBe(true);
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('A second report');
		expect(mockApi.calls.map((call) => call.url)).toEqual([
			'/api/projects/demo/feedback?limit=25',
			'/api/projects/demo/feedback?limit=25&cursor=cursor-2',
		]);
	});

	it('announces empty and error states accessibly', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.find('[role="status"]').text()).toContain('No feedback yet');
		wrapper.unmount();

		onGet('/api/projects/demo/feedback?limit=25', () => {
			throw new Error('Feedback service unavailable');
		});
		const errorWrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(errorWrapper.find('[role="alert"]').text()).toContain('Feedback service unavailable');
	});
});

describe('feedback detail screenshot', () => {
	it('fetches bytes with the bearer token and revokes the blob URL on unmount', async () => {
		const screenshotItem = { ...item, screenshotType: 'image/png', screenshotSize: 3 };
		onGet('/api/projects/demo/feedback/feedback-1', () => ({ feedback: screenshotItem }));
		const createObjectURL = vi.fn(() => 'blob:feedback-image');
		const revokeObjectURL = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			blob: async () => new Blob(['png'], { type: 'image/png' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/projects/demo/feedback/feedback-1/screenshot',
			expect.objectContaining({ headers: { Authorization: 'Bearer session-token' } }),
		);
		expect(wrapper.find('img').attributes('src')).toBe('blob:feedback-image');
		wrapper.unmount();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:feedback-image');
	});

	it('revokes the previous image URL before showing a replacement', async () => {
		const screenshotItem = { ...item, screenshotType: 'image/png', screenshotSize: 3 };
		onGet('/api/projects/demo/feedback/feedback-1', () => ({ feedback: screenshotItem }));
		onGet('/api/projects/demo/feedback/feedback-2', () => ({
			feedback: { ...screenshotItem, id: 'feedback-2' },
		}));
		const createObjectURL = vi
			.fn()
			.mockReturnValueOnce('blob:first-image')
			.mockReturnValueOnce('blob:second-image');
		const revokeObjectURL = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				blob: async () => new Blob(['png'], { type: 'image/png' }),
			}),
		);

		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();
		await router.push('/projects/demo/feedback/feedback-2');
		await flushPromises();

		expect(revokeObjectURL).toHaveBeenCalledWith('blob:first-image');
		expect(wrapper.find('img').attributes('src')).toBe('blob:second-image');
		wrapper.unmount();
	});

	it('rejects active or unsupported image content before creating a preview URL', async () => {
		onGet('/api/projects/demo/feedback/feedback-1', () => ({
			feedback: { ...item, screenshotType: 'image/png', metadata: { release: '1.0.0' } },
		}));
		const createObjectURL = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }),
			}),
		);
		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();
		expect(wrapper.text()).toContain('Application metadata');
		expect(wrapper.text()).toContain('1.0.0');
		expect(wrapper.get('[role="alert"]').text()).toContain('supported raster image');
		expect(createObjectURL).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('revokes a screenshot that resolves after the detail is unmounted', async () => {
		onGet('/api/projects/demo/feedback/feedback-1', () => ({
			feedback: { ...item, screenshotType: 'image/png' },
		}));
		let resolveFetch!: (value: unknown) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise((resolve) => {
						resolveFetch = resolve;
					}),
			),
		);
		const createObjectURL = vi.fn(() => 'blob:late-image');
		const revokeObjectURL = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();
		wrapper.unmount();
		resolveFetch({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) });
		await flushPromises();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:late-image');
	});

	it('shows the no-image state without requesting screenshot bytes', async () => {
		onGet('/api/projects/demo/feedback/feedback-1', () => ({ feedback: item }));
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();

		expect(wrapper.find('[role="status"]').text()).toContain('No screenshot was included');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
