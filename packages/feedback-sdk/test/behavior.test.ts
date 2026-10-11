import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFeedbackWidget, paintMasks } from '../src/index.js';
import { serializeMetadata } from '../src/utils.js';

const renderer = vi.hoisted(() => ({ toBlob: vi.fn() }));
vi.mock('html-to-image', () => renderer);
let widget: ReturnType<typeof installFeedbackWidget> | undefined;
afterEach(() => {
	widget?.destroy();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.clearAllMocks();
});
function form(
	collectMetadata?: (context: unknown) => unknown,
	onSubmit?: () => void,
	limits: { maxMetadataBytes?: number; maxPayloadBytes?: number } = {},
) {
	const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
	widget = installFeedbackWidget({
		dsn: 'https://key@example.test/project',
		screenshots: false,
		collectMetadata,
		onSubmit,
		...limits,
		fetch: fetcher,
	});
	const target = document.createElement('button');
	target.id = 'target';
	document.body.append(target);
	widget.open();
	const shadow = document.querySelector('[data-workers-sentinel-feedback]')!.shadowRoot!;
	target.click();
	return { shadow, target, fetcher };
}
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
describe('submission consent and metadata', () => {
	it('honors a caller metadata cap below 128 bytes', async () => {
		const { shadow, fetcher } = form(() => ({ release: 1 }), undefined, { maxMetadataBytes: 1 });
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Report';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		expect(shadow.querySelector('.error')!.textContent).toContain('limit');
	});
	it('honors a caller request cap below 16 KiB', async () => {
		const { shadow, fetcher } = form(undefined, undefined, { maxPayloadBytes: 1000 });
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'x'.repeat(1500);
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		expect(shadow.querySelector('.error')!.textContent).toContain('request byte limit');
	});
	it.each([
		'synchronous',
		'asynchronous',
	])('isolates a %s notification error from successful submission and reset', async (kind) => {
		const onSubmit = vi.fn(() => {
			if (kind === 'asynchronous')
				return Promise.reject(new Error('Application notification failed'));
			throw new Error('Application notification failed');
		});
		const { shadow, target, fetcher } = form(undefined, onSubmit);
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'First report';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith({ ok: true, status: 201 });
		expect(shadow.querySelector('.panel')!.textContent).toContain('Thank you!');
		shadow.querySelector<HTMLButtonElement>('.another')!.click();
		target.click();
		expect(shadow.querySelector<HTMLTextAreaElement>('.description')!.value).toBe('');
	});
	it('invokes the callback only at submission with bounded description/target context', async () => {
		const hook = vi.fn().mockResolvedValue({ release: '1.0' });
		const { shadow, fetcher } = form(hook);
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Reviewed description';
		expect(hook).not.toHaveBeenCalled();
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(hook).toHaveBeenCalledWith(
			expect.objectContaining({ description: 'Reviewed description', locator: '[id="target"]' }),
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const request = fetcher.mock.calls[0][1];
		expect(request.credentials).toBe('omit');
		expect(JSON.parse(request.body.get('metadata')).metadata).toEqual({ release: '1.0' });
	});
	it('requires separate continue-without-metadata and send actions after a callback error', async () => {
		const { shadow, fetcher } = form(() => {
			throw new Error('failed');
		});
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Description';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		expect(shadow.querySelector('.error')!.textContent).toContain('failed');
		shadow.querySelector<HTMLButtonElement>('.error button')!.click();
		expect(fetcher).not.toHaveBeenCalled();
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('times out a callback and never submits late data', async () => {
		vi.useFakeTimers();
		const { shadow, fetcher } = form(() => new Promise(() => {}));
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Description';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await vi.advanceTimersByTimeAsync(1600);
		expect(shadow.querySelector('.error')!.textContent).toContain('timed out');
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('shows capture failure but allows explicit Send feedback text-only submission', async () => {
		renderer.toBlob.mockRejectedValue(new Error('CSP blocked'));
		const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
		widget = installFeedbackWidget({
			dsn: 'https://key@example.test/project',
			fetch: fetcher,
		});
		const target = document.createElement('button');
		target.id = 'target';
		document.body.append(target);
		widget.open();
		target.click();
		const shadow = document.querySelector('[data-workers-sentinel-feedback]')!.shadowRoot!;
		await vi.waitFor(() => expect(shadow.querySelector('.panel')).not.toBeNull());
		expect(shadow.querySelector('.error')!.textContent).toContain('CSP blocked');
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Description';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0][1].body.has('screenshot')).toBe(false);
	});
	it('ignores metadata that resolves after close and reopen', async () => {
		let resolve!: (value: unknown) => void;
		const { shadow, fetcher } = form(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Old description';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		widget!.close();
		widget!.open();
		const freshTarget = document.createElement('button');
		freshTarget.id = 'fresh';
		document.body.append(freshTarget);
		freshTarget.click();
		const freshDescription = shadow.querySelector<HTMLTextAreaElement>('.description')!;
		freshDescription.value = 'Fresh description';
		resolve({ late: true });
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		expect(freshDescription.value).toBe('Fresh description');
		expect((shadow.querySelector('.error') as HTMLElement).hidden).toBe(true);
	});
	it('ignores a fetch that resolves after close and reopen', async () => {
		let resolveFetch!: (response: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const onSubmit = vi.fn();
		widget = installFeedbackWidget({
			dsn: 'https://key@example.test/project',
			screenshots: false,
			fetch: fetcher,
			onSubmit,
		});
		const target = document.createElement('button');
		target.id = 'target';
		document.body.append(target);
		widget.open();
		const shadow = document.querySelector('[data-workers-sentinel-feedback]')!.shadowRoot!;
		target.click();
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Old report';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
		widget.close();
		widget.open();
		const freshTarget = document.createElement('button');
		freshTarget.id = 'fresh';
		document.body.append(freshTarget);
		freshTarget.click();
		const freshDescription = shadow.querySelector<HTMLTextAreaElement>('.description')!;
		freshDescription.value = 'Fresh report';
		resolveFetch(new Response('{}', { status: 201 }));
		await settle();
		expect(freshDescription.value).toBe('Fresh report');
		expect(shadow.querySelector('.another')).toBeNull();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('reselects with a fresh capture and retains the description', async () => {
		const { shadow, target } = form();
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Keep this text';
		const second = document.createElement('button');
		second.id = 'second';
		document.body.append(second);
		shadow.querySelector<HTMLButtonElement>('.reselect')!.click();
		expect(shadow.querySelector('.panel')).toBeNull();
		second.click();
		await vi.waitFor(() => expect(shadow.querySelector('.panel')).not.toBeNull());
		expect(shadow.querySelector<HTMLTextAreaElement>('.description')!.value).toBe('Keep this text');
		expect(shadow.querySelector('.locator')!.textContent).toContain('second');
		expect(target.isConnected).toBe(true);
	});
	it('resets description and target for sequential successful reports', async () => {
		const { shadow, fetcher } = form();
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'First report';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(shadow.querySelector('.another')).not.toBeNull();
		shadow.querySelector<HTMLButtonElement>('.another')!.click();
		expect(shadow.querySelector('.panel')).toBeNull();
		const second = document.createElement('button');
		second.id = 'second';
		document.body.append(second);
		second.click();
		await vi.waitFor(() => expect(shadow.querySelector('.panel')).not.toBeNull());
		expect(shadow.querySelector<HTMLTextAreaElement>('.description')!.value).toBe('');
		expect(shadow.querySelector('.locator')!.textContent).toContain('second');
		shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Second report';
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(JSON.parse(fetcher.mock.calls[1][1].body.get('metadata')).description).toBe(
			'Second report',
		);
	});
});
describe('strict metadata and bitmap scale', () => {
	it('rejects non-JSON values rather than silently dropping them', () => {
		for (const value of [
			{ fn: () => {} },
			{ bad: NaN },
			{ bad: Infinity },
			{ bad: undefined },
			new Date(),
			new Array(3),
		]) {
			expect(() => serializeMetadata(value, 8192)).toThrow();
		}
		expect(() => serializeMetadata({ data: 'x'.repeat(9000) }, 8192)).toThrow(/limit/);
	});
	it('burns opaque masks into actual image coordinates with independent x/y scale', () => {
		const context = { fillStyle: '', fillRect: vi.fn() };
		paintMasks(
			context as unknown as CanvasRenderingContext2D,
			[{ x: 10, y: 20, width: 30, height: 40 }],
			2,
			0.5,
		);
		expect(context.fillStyle).toBe('#111827');
		expect(context.fillRect).toHaveBeenCalledWith(19, 9, 63, 23);
	});
});
