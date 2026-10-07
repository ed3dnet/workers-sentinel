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
function form(collectMetadata?: (context: unknown) => unknown, screenshots = false) {
	const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
	widget = installFeedbackWidget({
		dsn: 'https://key@example.test/project',
		screenshots,
		collectMetadata,
		fetch: fetcher,
	});
	const target = document.createElement('button');
	target.id = 'target';
	document.body.append(target);
	widget.open();
	const shadow = document.querySelector('[data-workers-sentinel-feedback]')!.shadowRoot!;
	shadow.querySelector<HTMLTextAreaElement>('.description')!.value = 'Reviewed description';
	shadow.querySelector<HTMLButtonElement>('.picker')!.click();
	target.click();
	return { shadow, target, fetcher };
}
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
describe('submission consent and metadata', () => {
	it('invokes the callback only at submission with bounded description/target context', async () => {
		const hook = vi.fn().mockResolvedValue({ release: '1.0' });
		const { shadow, fetcher } = form(hook);
		expect(hook).not.toHaveBeenCalled();
		shadow.querySelector<HTMLButtonElement>('.text-only')!.click();
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
		shadow.querySelector<HTMLButtonElement>('.text-only')!.click();
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
		shadow.querySelector<HTMLButtonElement>('.text-only')!.click();
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await vi.advanceTimersByTimeAsync(1600);
		expect(shadow.querySelector('.error')!.textContent).toContain('timed out');
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('shows renderer failure and does not send without an explicit text-only choice', async () => {
		renderer.toBlob.mockRejectedValue(new Error('CSP blocked'));
		const { shadow, fetcher } = form(undefined, true);
		shadow.querySelector<HTMLButtonElement>('.capture')!.click();
		await settle();
		expect(shadow.querySelector('.error')!.textContent).toContain('CSP blocked');
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		shadow.querySelector<HTMLButtonElement>('.text-only')!.click();
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('does not submit or mutate a reopened form after teardown during a hook', async () => {
		let resolve!: (value: unknown) => void;
		const { shadow, fetcher } = form(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		shadow.querySelector<HTMLButtonElement>('.text-only')!.click();
		shadow.querySelector<HTMLButtonElement>('.submit')!.click();
		await settle();
		widget!.close();
		widget!.open();
		resolve({ late: true });
		await settle();
		expect(fetcher).not.toHaveBeenCalled();
		expect(shadow.querySelector('.description')).not.toBeNull();
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
