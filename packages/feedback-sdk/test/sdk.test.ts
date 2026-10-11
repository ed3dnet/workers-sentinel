import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFeedbackWidget } from '../src/index.js';
import { resolveConnection, serializeMetadata } from '../src/utils.js';

const htmlToImage = vi.hoisted(() => ({ toBlob: vi.fn() }));
vi.mock('html-to-image', () => htmlToImage);
const installed: Array<{ destroy(): void }> = [];

function hostShadow() {
	return document.querySelector<HTMLElement>('[data-workers-sentinel-feedback]')!.shadowRoot!;
}

afterEach(() => {
	for (const widget of installed.splice(0)) widget.destroy();
	document.body.replaceChildren();
});

beforeEach(() => {
	htmlToImage.toBlob.mockReset();
});

describe('feedback SDK helpers', () => {
	it('extracts the project and key from a normal DSN', () => {
		expect(resolveConnection({ dsn: 'https://public@example.test/42' })).toEqual({
			baseUrl: 'https://example.test',
			projectId: '42',
			publicKey: 'public',
		});
	});

	it('preserves deployment prefixes but avoids duplicating an /api suffix', () => {
		expect(resolveConnection({ dsn: 'https://public@example.test/sentinel/api/42' })).toEqual({
			baseUrl: 'https://example.test/sentinel',
			projectId: '42',
			publicKey: 'public',
		});
		expect(
			resolveConnection({
				serverUrl: 'https://example.test/sentinel/api/',
				projectId: 'p',
				publicKey: 'k',
			}).baseUrl,
		).toBe('https://example.test/sentinel');
	});

	it('rejects malformed connection details', () => {
		expect(() => resolveConnection({})).toThrow(/Provide either/);
		expect(() => resolveConnection({ dsn: 'not a URL' })).toThrow(/valid absolute URL/);
		expect(() => resolveConnection({ dsn: 'https://key:password@example.test/42' })).toThrow(
			/without password/,
		);
	});

	it('serializes bounded JSON metadata accepted by the worker', () => {
		expect(serializeMetadata({ count: 2 }, 100)).toBe('{"count":2}');
		expect(() => serializeMetadata({ value: 'x'.repeat(20) }, 5)).toThrow(/limit/);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => serializeMetadata(circular, 100)).toThrow(/bounded JSON/);
		expect(() => serializeMetadata({ a: { b: { c: { d: { e: { f: 1 } } } } } }, 100)).toThrow(
			/bounded JSON/,
		);
	});
});

describe('widget lifecycle', () => {
	it('installs launcher with requested label, placement and style nonce', () => {
		const widget = installFeedbackWidget({
			serverUrl: 'https://sentinel.example',
			projectId: 'p1',
			publicKey: 'key',
			launcherLabel: 'Report a problem',
			placement: 'top-left',
			styleNonce: 'nonce-1',
		});
		installed.push(widget);
		const host = document.querySelector<HTMLElement>('[data-workers-sentinel-feedback]')!;
		expect(host.shadowRoot?.querySelector('button.launcher')?.textContent).toBe('Report a problem');
		expect(host.dataset.placement).toBe('top-left');
		expect(host.shadowRoot?.querySelector('style')?.nonce).toBe('nonce-1');
		widget.destroy();
		expect(document.querySelector('[data-workers-sentinel-feedback]')).toBeNull();
	});

	it('starts selection immediately and shows no dialog until automatic capture settles', async () => {
		let rejectCapture!: (cause: Error) => void;
		htmlToImage.toBlob.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectCapture = reject;
				}),
		);
		const widget = installFeedbackWidget({
			serverUrl: 'https://sentinel.example',
			projectId: 'p1',
			publicKey: 'key',
		});
		installed.push(widget);
		const target = document.createElement('button');
		target.dataset.testid = 'save';
		document.body.append(target);
		widget.open();
		const shadow = hostShadow();
		expect(shadow.querySelector('.panel')).toBeNull();
		expect(shadow.querySelector('.waiting-message')?.textContent).toContain(
			'Select a page element',
		);
		widget.open(); // Duplicate open does not replace the active selection flow.
		expect(shadow.querySelectorAll('.waiting')).toHaveLength(1);
		target.click();
		expect(htmlToImage.toBlob).toHaveBeenCalledTimes(1);
		expect(shadow.querySelector('.panel')).toBeNull();
		expect(shadow.querySelector('.waiting-message')?.textContent).toContain('Capturing');
		rejectCapture(new Error('renderer blocked'));
		await vi.waitFor(() => expect(shadow.querySelector('.panel')).not.toBeNull());
		expect(shadow.querySelector('.locator')?.textContent).toContain('data-testid');
		expect(shadow.querySelector('[role="alert"]')?.textContent).toContain('renderer blocked');
	});

	it('cancels selection and pending capture without rendering stale forms', async () => {
		let resolveCapture!: (blob: Blob) => void;
		htmlToImage.toBlob.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCapture = resolve;
				}),
		);
		const widget = installFeedbackWidget({
			serverUrl: 'https://sentinel.example',
			projectId: 'p1',
			publicKey: 'key',
		});
		installed.push(widget);
		const target = document.createElement('button');
		document.body.append(target);
		widget.open();
		const shadow = hostShadow();
		shadow.querySelector<HTMLButtonElement>('.waiting-cancel')!.click();
		expect(shadow.querySelector('.waiting')).toBeNull();
		expect(document.querySelectorAll('.highlight')).toHaveLength(0);
		widget.open();
		target.click();
		widget.close();
		resolveCapture(new Blob(['image-bytes'], { type: 'image/png' }));
		await Promise.resolve();
		await Promise.resolve();
		expect(shadow.querySelector('.panel')).toBeNull();
		expect(shadow.querySelector('.waiting')).toBeNull();
	});

	it('does not render after destroy while screenshot rendering is pending', async () => {
		let rejectCapture!: (cause: Error) => void;
		htmlToImage.toBlob.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectCapture = reject;
				}),
		);
		const widget = installFeedbackWidget({
			serverUrl: 'https://sentinel.example',
			projectId: 'p1',
			publicKey: 'key',
		});
		const target = document.createElement('button');
		document.body.append(target);
		widget.open();
		target.click();
		const shadow = hostShadow();
		expect(htmlToImage.toBlob).toHaveBeenCalledTimes(1);
		widget.destroy();
		rejectCapture(new Error('late renderer failure'));
		await Promise.resolve();
		await Promise.resolve();
		expect(shadow.querySelector('.panel')).toBeNull();
		expect(document.querySelector('[data-workers-sentinel-feedback]')).toBeNull();
	});

	it('shows the form after selection when screenshots are disabled', async () => {
		const widget = installFeedbackWidget({
			serverUrl: 'https://sentinel.example',
			projectId: 'p1',
			publicKey: 'key',
			screenshots: false,
		});
		installed.push(widget);
		const target = document.createElement('button');
		target.dataset.testid = 'save';
		document.body.append(target);
		widget.open();
		const shadow = hostShadow();
		expect(shadow.querySelector('.panel')).toBeNull();
		target.click();
		expect(htmlToImage.toBlob).not.toHaveBeenCalled();
		expect(shadow.querySelector('.panel')).not.toBeNull();
		expect((shadow.querySelector('.locator') as HTMLElement).textContent).toContain('data-testid');
		expect(shadow.querySelector('.text-only')).toBeNull();
		expect(shadow.querySelector('.capture-status')?.textContent).toContain('disabled');
	});

	it('rejects installation without a browser document', () => {
		const original = globalThis.document;
		vi.stubGlobal('document', undefined);
		expect(() =>
			installFeedbackWidget({
				serverUrl: 'https://sentinel.example',
				projectId: 'p1',
				publicKey: 'key',
			}),
		).toThrow(/browser/);
		vi.stubGlobal('document', original);
	});
});
