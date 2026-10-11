interface FeedbackWidget {
	destroy(): void;
}
interface FeedbackInstaller {
	install(options: {
		dsn: string;
		launcherLabel: string;
		privateSelectors: string[];
		collectMetadata: () => { application: string; route: string };
	}): FeedbackWidget;
}
declare global {
	interface Window {
		WorkersSentinelFeedback?: FeedbackInstaller;
	}
}

/** Install once per dashboard lifetime, only when the operator configured a DSN. */
export function startDashboardFeedback(): () => void {
	let stopped = false;
	let widget: FeedbackWidget | undefined;
	let script: HTMLScriptElement | undefined;
	void (async () => {
		try {
			const response = await fetch('/api/dashboard-config', { credentials: 'omit' });
			if (!response.ok || stopped) return;
			const config = (await response.json()) as { feedbackDsn?: unknown };
			if (stopped || typeof config.feedbackDsn !== 'string' || !config.feedbackDsn.trim()) return;
			const dsn = config.feedbackDsn.trim();
			if (!window.WorkersSentinelFeedback) {
				script = document.createElement('script');
				script.src = '/sdk/feedback.js';
				await new Promise<void>((resolve, reject) => {
					script!.onload = () => resolve();
					script!.onerror = () => reject(new Error('Feedback SDK could not be loaded.'));
					document.head.append(script!);
				});
			}
			if (stopped) return;
			widget = window.WorkersSentinelFeedback?.install({
				dsn,
				launcherLabel: 'Send feedback',
				privateSelectors: ['input', 'textarea', 'select', '[data-sentinel-feedback-private]'],
				collectMetadata: () => ({
					application: 'workers-sentinel-dashboard',
					route: location.pathname,
				}),
			});
		} catch {
			// Feedback is optional; a missing/invalid DSN or SDK must not prevent dashboard use.
			console.warn('Dashboard feedback could not be initialized.');
		}
	})();
	return () => {
		stopped = true;
		widget?.destroy();
		script?.remove();
	};
}
