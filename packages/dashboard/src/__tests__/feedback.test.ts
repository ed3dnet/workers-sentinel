import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Feedback from '../views/Feedback.vue';
import FeedbackDetail from '../views/FeedbackDetail.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { mockApi, onGet, onPatch } from './mocks';

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
	status: 'unresolved' | 'resolved';
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
	status: 'unresolved',
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

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
	it('opens Quick Setup for an empty project after navigating from a populated one', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [item], hasMore: false }));
		onGet('/api/projects/empty/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		onGet('/api/projects/demo', () => ({ dsn: 'https://key@sentinel.example/demo' }));
		onGet('/api/projects/empty', () => ({ dsn: 'https://key@sentinel.example/empty' }));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.get('details').element.open).toBe(false);
		await router.push('/projects/empty/feedback');
		await flushPromises();
		expect(wrapper.text()).toContain('No feedback yet');
		expect(wrapper.get('details').element.open).toBe(true);
		await wrapper.get('summary').trigger('click');
		await flushPromises();
		expect(wrapper.get('details').element.open).toBe(false);
		wrapper.unmount();
	});

	it('uses the Issues relative-time labels while preserving the machine-readable timestamp', async () => {
		const now = Date.now();
		const recent = { ...item, receivedAt: new Date(now - 5 * 60 * 1000).toISOString() };
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [recent], hasMore: false }));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.get('time').text()).toBe('5m ago');
		expect(wrapper.get('time').attributes('datetime')).toBe(recent.receivedAt);
		wrapper.unmount();
	});
	it('filters rendered rows, pages with a cursor, and resets paging when filters or page size change', async () => {
		const second = { ...item, id: 'feedback-2', description: 'A second report' };
		const resolved = {
			...item,
			id: 'feedback-resolved',
			description: 'Resolved report',
			status: 'resolved' as const,
		};
		onGet('/api/projects/demo/feedback?limit=25', () => ({
			feedback: [item],
			nextCursor: 'older',
			hasMore: true,
		}));
		onGet('/api/projects/demo/feedback?limit=25&cursor=older', () => ({
			feedback: [second],
			hasMore: false,
		}));
		onGet('/api/projects/demo/feedback?limit=25&status=resolved', () => ({
			feedback: [resolved],
			nextCursor: 'resolved-cursor',
			hasMore: true,
		}));
		onGet('/api/projects/demo/feedback?limit=25&status=resolved&query=save', () => ({
			feedback: [resolved],
			nextCursor: 'search-cursor',
			hasMore: true,
		}));
		onGet(
			'/api/projects/demo/feedback?limit=25&status=resolved&query=save&cursor=search-cursor',
			() => ({ feedback: [second], hasMore: false }),
		);
		onGet('/api/projects/demo/feedback?limit=50&status=resolved&query=save', () => ({
			feedback: [resolved],
			hasMore: false,
		}));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.text()).toContain(item.description);
		expect(wrapper.get('details summary').text()).toBe('Quick Setup');
		expect(wrapper.get('details').element.open).toBe(false);
		expect(wrapper.get('.badge').text()).toBe('unresolved');
		expect(wrapper.get('.badge').classes()).toContain('badge-info');
		expect(wrapper.get('.card > div').classes()).toContain('hover:bg-gray-50');
		await wrapper
			.findAll('button')
			.find((button) => button.text().includes('Load More'))
			?.trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain(second.description);
		await wrapper.get('select[aria-label="Feedback status"]').setValue('resolved');
		await flushPromises();
		expect(wrapper.text()).toContain('Resolved report');
		expect(wrapper.text()).not.toContain(item.description);
		await wrapper.get('input[type="search"]').setValue('save');
		await new Promise((resolve) => setTimeout(resolve, 275));
		await flushPromises();
		await wrapper
			.findAll('button')
			.find((button) => button.text().includes('Load More'))
			?.trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain(second.description);
		await wrapper.get('select[aria-label="Feedback per page"]').setValue('50');
		await flushPromises();
		expect(wrapper.text()).toContain('Resolved report');
		expect(mockApi.calls.map((call) => call.url)).toEqual([
			'/api/projects/demo/feedback?limit=25',
			'/api/projects/demo',
			'/api/projects/demo/feedback?limit=25&cursor=older',
			'/api/projects/demo/feedback?limit=25&status=resolved',
			'/api/projects/demo/feedback?limit=25&status=resolved&query=save',
			'/api/projects/demo/feedback?limit=25&status=resolved&query=save&cursor=search-cursor',
			'/api/projects/demo/feedback?limit=50&status=resolved&query=save',
		]);
		wrapper.unmount();
	});

	it('resolves and reopens feedback from the list', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [item], hasMore: false }));
		onPatch('/api/projects/demo/feedback/feedback-1', () => ({}));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(mockApi.calls.at(-1)).toMatchObject({ method: 'patch', body: { status: 'resolved' } });
		expect(wrapper.text()).toContain('resolved');
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(mockApi.calls.at(-1)).toMatchObject({ method: 'patch', body: { status: 'unresolved' } });
		wrapper.unmount();
	});

	it('ignores a stale list response after changing the status filter', async () => {
		const oldPage = deferred<{ feedback: FeedbackItem[]; hasMore: boolean }>();
		onGet('/api/projects/demo/feedback?limit=25', () => oldPage.promise);
		onGet('/api/projects/demo/feedback?limit=25&status=resolved', () => ({
			feedback: [
				{
					...item,
					id: 'resolved-new',
					description: 'Current filtered feedback',
					status: 'resolved',
				},
			],
			hasMore: false,
		}));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		await wrapper.get('select[aria-label="Feedback status"]').setValue('resolved');
		await flushPromises();
		expect(wrapper.text()).toContain('Current filtered feedback');
		oldPage.resolve({ feedback: [item], hasMore: false });
		await flushPromises();
		expect(wrapper.text()).toContain('Current filtered feedback');
		expect(wrapper.text()).not.toContain(item.description);
		wrapper.unmount();
	});

	it('ignores an earlier project DSN and clears it while navigating projects', async () => {
		const nextProject = deferred<{ dsn: string }>();
		const lateProject = deferred<{ dsn: string }>();
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		onGet('/api/projects/demo', () => ({ dsn: 'https://old-key@old.example/project-1' }));
		onGet('/api/projects/next/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		onGet('/api/projects/next', () => nextProject.promise);
		onGet('/api/projects/late/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		onGet('/api/projects/late', () => lateProject.promise);
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.text()).toContain('https://old.example/sdk/feedback.js');
		await router.push('/projects/next/feedback');
		await flushPromises();
		expect(wrapper.text()).not.toContain('https://old.example/sdk/feedback.js');
		expect(wrapper.text()).toContain('Project DSN is unavailable');
		nextProject.resolve({ dsn: 'https://next-key@next.example/project-2' });
		await flushPromises();
		expect(wrapper.text()).toContain('https://next.example/sdk/feedback.js');
		await router.push('/projects/late/feedback');
		await flushPromises();
		await router.push('/projects/demo/feedback');
		await flushPromises();
		expect(wrapper.text()).toContain('https://old.example/sdk/feedback.js');
		lateProject.resolve({ dsn: 'https://late-key@late.example/project-3' });
		await flushPromises();
		expect(wrapper.text()).toContain('https://old.example/sdk/feedback.js');
		expect(wrapper.text()).not.toContain('https://late.example/sdk/feedback.js');
		expect(mockApi.calls.map((call) => call.url)).toContain('/api/projects/next/feedback?limit=25');
		wrapper.unmount();
	});

	it('ignores stale list mutations after navigation and blocks duplicate clicks', async () => {
		const mutation = deferred<unknown>();
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [item], hasMore: false }));
		onGet('/api/projects/next/feedback?limit=25', () => ({
			feedback: [{ ...item, id: 'next-item', description: 'Next project report' }],
			hasMore: false,
		}));
		onPatch('/api/projects/demo/feedback/feedback-1', () => mutation.promise);
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		const resolveButton = wrapper.findAll('button').find((button) => button.text() === 'Resolve');
		await resolveButton?.trigger('click');
		await resolveButton?.trigger('click');
		expect(mockApi.calls.filter((call) => call.method === 'patch')).toHaveLength(1);
		await router.push('/projects/next/feedback');
		await flushPromises();
		mutation.resolve({});
		await flushPromises();
		expect(wrapper.text()).toContain('Next project report');
		expect(wrapper.text()).not.toContain('Updating…');
		expect(mockApi.calls.filter((call) => call.method === 'patch')).toHaveLength(1);
		wrapper.unmount();
	});

	it('renders the hosted SDK from the DSN origin without credentials in the asset URL', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		onGet('/api/projects/demo', () => ({
			dsn: 'https://public-key:secret@sentinel.example/project-1',
		}));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		expect(wrapper.text()).toContain('/sdk/feedback.js');
		expect(wrapper.text()).toContain('https://sentinel.example/sdk/feedback.js');
		expect(wrapper.text()).toContain('WorkersSentinelFeedback.install');
		expect(wrapper.text()).toContain('Quick Setup');
		const search = wrapper.get('input[type="search"]');
		expect(search.attributes('placeholder')).toBe('Search feedback');
		expect(wrapper.get('label[for="feedback-search"]').text()).toBe('Search feedback');
		expect(search.classes()).toContain('w-auto');
		expect(wrapper.get('select[aria-label="Feedback status"]').text()).toContain('All Feedback');
		expect(wrapper.get('select[aria-label="Feedback per page"]').text()).toContain('25 / page');
		expect(wrapper.get('select[aria-label="Feedback per page"]').text()).toContain('50 / page');
		expect(wrapper.get('select[aria-label="Feedback per page"]').text()).toContain('100 / page');
		expect(wrapper.get('pre').classes()).toEqual(
			expect.arrayContaining(['bg-gray-900', 'text-gray-100', 'rounded-lg', 'p-4']),
		);
		expect(wrapper.text()).toContain('public-key:secret@sentinel.example/project-1');
		expect(wrapper.text()).not.toContain(
			'https://public-key:secret@sentinel.example/sdk/feedback.js',
		);
		expect(wrapper.find('a[href="/sdk/SKILL.md"]').attributes('href')).toBe('/sdk/SKILL.md');
		expect(wrapper.text()).toContain('consent');
		expect(wrapper.text()).toContain('not confirmed');
		expect(wrapper.text()).not.toMatch(/npm\s+install|pnpm\s+add/);
		const setup = wrapper.get('details');
		expect(setup.element.open).toBe(true);
		await setup.get('summary').trigger('click');
		await flushPromises();
		expect(setup.element.open).toBe(false);
		wrapper.unmount();
	});

	it('shows a distinct no-match state when a filter returns no rows', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [item], hasMore: false }));
		onGet('/api/projects/demo/feedback?limit=25&status=resolved', () => ({
			feedback: [],
			hasMore: false,
		}));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		await wrapper.get('select[aria-label="Feedback status"]').setValue('resolved');
		await flushPromises();
		expect(wrapper.find('[role="status"]').text()).toContain('No feedback matches these filters');
		expect(wrapper.text()).not.toContain(item.description);
		expect(wrapper.text()).not.toContain('No feedback yet');
		expect(wrapper.get('summary').text()).toBe('Quick Setup');
		expect(wrapper.get('details').element.open).toBe(false);
		await wrapper.get('summary').trigger('click');
		await flushPromises();
		expect(wrapper.get('details').element.open).toBe(true);
		wrapper.unmount();
	});

	it('loads feedback and appends the cursor page', async () => {
		onGet('/api/projects/demo', () => ({ dsn: 'https://public-key@sentinel.example/project-1' }));
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
		await wrapper
			.findAll('button')
			.find((button) => button.text().includes('Load More'))
			?.trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('A second report');
		expect(mockApi.calls.map((call) => call.url)).toEqual([
			'/api/projects/demo/feedback?limit=25',
			'/api/projects/demo',
			'/api/projects/demo/feedback?limit=25&cursor=cursor-2',
		]);
	});

	it('announces empty and error states accessibly', async () => {
		onGet('/api/projects/demo/feedback?limit=25', () => ({ feedback: [], hasMore: false }));
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback');
		const wrapper = mount(Feedback, { global: { plugins: [router] } });
		await flushPromises();
		const emptyState = wrapper.find('[role="status"]');
		expect(emptyState.text()).toContain('No feedback yet');
		expect(emptyState.text()).toContain('Configure your SDK to start capturing feedback.');
		expect(emptyState.classes()).toContain('max-w-2xl');
		expect(emptyState.get('svg').classes()).toEqual(['mx-auto', 'h-12', 'w-12', 'text-gray-400']);
		expect(emptyState.get('svg path').attributes('d')).toBe(
			'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
		);
		expect(emptyState.get('h3').classes()).toContain('text-lg');
		expect(emptyState.get('details').classes()).toEqual(
			expect.arrayContaining(['bg-gray-50', 'dark:bg-gray-700', 'rounded-lg', 'p-6', 'mt-6']),
		);
		expect(emptyState.get('details').element.open).toBe(true);
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
	it('resolves and reopens feedback from the detail view', async () => {
		onGet('/api/projects/demo/feedback/feedback-1', () => ({ feedback: { ...item } }));
		onPatch('/api/projects/demo/feedback/feedback-1', () => ({}));
		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(mockApi.calls.at(-1)).toMatchObject({ method: 'patch', body: { status: 'resolved' } });
		expect(wrapper.text()).toContain('resolved');
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(mockApi.calls.at(-1)).toMatchObject({ method: 'patch', body: { status: 'unresolved' } });
		expect(wrapper.text()).toContain('unresolved');
		wrapper.unmount();
	});

	it('ignores a pending detail mutation after navigating and blocks duplicate clicks', async () => {
		const mutation = deferred<unknown>();
		onGet('/api/projects/demo/feedback/feedback-1', () => ({ feedback: { ...item } }));
		onGet('/api/projects/demo/feedback/feedback-2', () => ({
			feedback: { ...item, id: 'feedback-2', description: 'Second detail' },
		}));
		onPatch('/api/projects/demo/feedback/feedback-1', () => mutation.promise);
		const { pinia } = seedAuth();
		const router = testRouter();
		await atRoute(router, '/projects/demo/feedback/feedback-1');
		const wrapper = mount(FeedbackDetail, { global: { plugins: [pinia, router] } });
		await flushPromises();
		const resolveButton = wrapper.findAll('button').find((button) => button.text() === 'Resolve');
		await resolveButton?.trigger('click');
		await resolveButton?.trigger('click');
		expect(mockApi.calls.filter((call) => call.method === 'patch')).toHaveLength(1);
		await router.push('/projects/demo/feedback/feedback-2');
		await flushPromises();
		mutation.resolve({});
		await flushPromises();
		expect(wrapper.text()).toContain('Second detail');
		expect(wrapper.text()).toContain('unresolved');
		expect(mockApi.calls.filter((call) => call.method === 'patch')).toHaveLength(1);
		wrapper.unmount();
	});

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
