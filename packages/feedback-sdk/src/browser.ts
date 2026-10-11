import type { FeedbackWidget, FeedbackWidgetOptions } from './index.js';
import { installFeedbackWidget } from './index.js';

const browserApi = { install: installFeedbackWidget };
if (typeof window !== 'undefined') {
	window.WorkersSentinelFeedback = browserApi;
}

export const install = installFeedbackWidget;

declare global {
	interface Window {
		WorkersSentinelFeedback: {
			install(options: FeedbackWidgetOptions): FeedbackWidget;
		};
	}
}
export type { FeedbackWidgetOptions };
