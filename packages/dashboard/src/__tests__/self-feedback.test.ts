import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let appendedScript: HTMLScriptElement | undefined;
beforeEach(() => {
	appendedScript = undefined;
	vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
		appendedScript = nodes[0] as HTMLScriptElement;
	});
});

import { startDashboardFeedback } from '../lib/self-feedback';

let stop: (() => void) | undefined;
afterEach(() => {
	stop?.();
	delete window.WorkersSentinelFeedback;
	document.head.querySelectorAll('script[src="/sdk/feedback.js"]').forEach((script) => {
		script.remove();
	});
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const settle = async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};
describe('dashboard self-feedback installation', () => {
	it('does not load or install when no DSN is configured', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feedbackDsn: null }) }),
		);
		stop = startDashboardFeedback();
		await settle();
		expect(document.querySelector('script[src="/sdk/feedback.js"]')).toBeNull();
	});
	it('loads same-origin SDK and registers only safe application metadata and privacy masks', async () => {
		const fetcher = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ feedbackDsn: 'https://key@sentinel.test/project' }),
		});
		vi.stubGlobal('fetch', fetcher);
		const destroy = vi.fn();
		const install = vi.fn((_options: { collectMetadata: () => unknown }) => ({ destroy }));
		stop = startDashboardFeedback();
		await settle();
		const script = appendedScript!;
		expect(script.getAttribute('src')).toBe('/sdk/feedback.js');
		window.WorkersSentinelFeedback = { install };
		script.dispatchEvent(new Event('load'));
		await settle();
		expect(fetcher).toHaveBeenCalledWith('/api/dashboard-config', { credentials: 'omit' });
		expect(install).toHaveBeenCalledWith(
			expect.objectContaining({
				dsn: 'https://key@sentinel.test/project',
				launcherLabel: 'Send feedback',
				privateSelectors: expect.arrayContaining(['input', 'textarea', 'select']),
			}),
		);
		expect(install.mock.calls[0][0].collectMetadata()).toEqual({
			application: 'workers-sentinel-dashboard',
			route: location.pathname,
		});
		stop();
		expect(destroy).toHaveBeenCalledTimes(1);
	});
	it('does not install after cleanup while script loading is pending', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ feedbackDsn: 'https://key@sentinel.test/project' }),
			}),
		);
		stop = startDashboardFeedback();
		await settle();
		const script = appendedScript!;
		stop();
		const install = vi.fn();
		window.WorkersSentinelFeedback = { install };
		script.dispatchEvent(new Event('load'));
		await settle();
		expect(install).not.toHaveBeenCalled();
	});
});
