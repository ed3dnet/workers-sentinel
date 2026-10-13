// @vitest-environment jsdom
// jsdom, not the suite-default happy-dom: DOMPurify's document traversal
// misbehaves under happy-dom (drops allowed elements like <p>, and
// happy-dom executes inline <script> content during DOMParser parsing,
// which aborts sanitization). jsdom matches browser behavior — verified
// against the same marked+DOMPurify pipeline this file exercises.
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import IssueDetail from '../views/IssueDetail.vue';
import { seedAuth } from './helpers';
import { mockApi, onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

// Long enough that its first 80 characters (the title budget) end well
// before the trailing detail only the message box may show.
const LONG_MESSAGE = `Payment failed for order **#12345** — retry per [runbook](https://example.com/runbook).

- Retry the charge
- Notify \`finance\`
- trailing detail that must appear in the message box but never in the title`;

function makeEvent(overrides: Record<string, unknown> = {}) {
	return {
		event_id: 'evt-1',
		timestamp: '2026-10-11T10:00:00Z',
		level: 'error',
		platform: 'javascript',
		exception: {
			values: [
				{
					type: 'PaymentError',
					value: LONG_MESSAGE,
					stacktrace: {
						frames: [{ filename: 'app.js', function: 'chargeOrder', lineno: 42, in_app: true }],
					},
				},
			],
		},
		...overrides,
	};
}

async function mountIssueDetail(events: unknown[]) {
	onGet('/api/projects/demo/issues/issue-1', () => ({
		issue: {
			id: 'issue-1',
			title: 'PaymentError',
			culprit: null,
			level: 'error',
			platform: 'javascript',
			firstSeen: '2026-10-11T09:00:00Z',
			lastSeen: '2026-10-11T10:00:00Z',
			count: 1,
			userCount: 1,
			status: 'unresolved',
			snoozedUntil: null,
			metadata: { type: 'PaymentError', value: LONG_MESSAGE },
		},
	}));
	onGet('/api/projects/demo/issues/issue-1/events?limit=10', () => ({ events }));
	onGet('/api/projects/demo/issues/issue-1/activity', () => ({ activity: [] }));

	const { pinia } = seedAuth();
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/projects/:slug/issues/:issueId', component: { template: '<div />' } },
			{ path: '/projects/:slug/issues', component: { template: '<div />' } },
		],
	});
	await router.push('/projects/demo/issues/issue-1');
	await router.isReady();

	const wrapper = mount(IssueDetail, {
		global: {
			plugins: [pinia, router],
			stubs: { AttachmentList: true },
		},
	});
	await flushPromises();
	return wrapper;
}

describe('issue detail message box', () => {
	it('renders the full message as markdown above the stack trace; the title keeps only 80 chars', async () => {
		const wrapper = await mountIssueDetail([makeEvent()]);

		const box = wrapper.find('[data-testid="issue-message"]');
		expect(box.exists()).toBe(true);

		// Markdown is rendered, not shown as source
		expect(box.html()).toContain('<strong>#12345</strong>');
		expect(box.html()).toContain('<code>finance</code>');
		expect(box.html()).toContain('href="https://example.com/runbook"');
		// Links open in a new tab (event messages are untrusted input)
		expect(box.html()).toContain('target="_blank"');
		expect(box.html()).toContain('rel="noopener noreferrer"');
		// The full message lives in the box…
		expect(box.text()).toContain('trailing detail');

		// …in a card above the Stack Trace card
		const html = wrapper.html();
		expect(html.indexOf('data-testid="issue-message"')).toBeLessThan(html.indexOf('>Stack Trace<'));

		// The page title carries only the first 80 characters
		const title = wrapper.find('h1').text();
		expect(title).toContain(`${LONG_MESSAGE.slice(0, 80)}…`);
		expect(title).not.toContain('trailing detail');
	});

	it('sanitizes HTML embedded in the message', async () => {
		const wrapper = await mountIssueDetail([
			makeEvent({
				exception: {
					values: [
						{
							type: 'XSS',
							value:
								'boom <script>alert(1)</script><img src=x onerror=alert(1)> [ok](https://example.com)',
							stacktrace: { frames: [] },
						},
					],
				},
			}),
		]);

		const box = wrapper.find('[data-testid="issue-message"]');
		expect(box.exists()).toBe(true);
		expect(box.html()).not.toContain('<script');
		expect(box.html()).not.toContain('<img');
		expect(box.html()).not.toContain('onerror');
		// Safe markdown survives the sanitizer
		expect(box.html()).toContain('href="https://example.com"');
	});

	it('renders message-only events from the top-level message field', async () => {
		const wrapper = await mountIssueDetail([
			makeEvent({ exception: undefined, message: 'plain message with **markdown**' }),
		]);

		const box = wrapper.find('[data-testid="issue-message"]');
		expect(box.exists()).toBe(true);
		expect(box.html()).toContain('<strong>markdown</strong>');
	});

	it('shows no message box when the event has no message', async () => {
		const wrapper = await mountIssueDetail([
			makeEvent({
				exception: { values: [{ type: 'Error', stacktrace: { frames: [] } }] },
			}),
		]);

		expect(wrapper.find('[data-testid="issue-message"]').exists()).toBe(false);
		expect(mockApi.calls.length).toBeGreaterThan(0);
	});
});
