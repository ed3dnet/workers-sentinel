import { toBlob } from 'html-to-image';
import {
	boundedNumber,
	type ConnectionOptions,
	resolveConnection,
	serializeMetadata,
} from './utils.js';

export type FeedbackPlacement = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export interface FeedbackTheme {
	accentColor?: string;
	accentTextColor?: string;
	backgroundColor?: string;
	textColor?: string;
	mutedColor?: string;
	borderColor?: string;
}
export interface FeedbackMetadataContext {
	pageUrl: string;
	pageTitle: string;
	locator: string;
	description: string;
	geometry: { x: number; y: number; width: number; height: number } | null;
}
export interface FeedbackWidgetOptions extends ConnectionOptions {
	launcherLabel?: string;
	styleNonce?: string;
	privateSelectors?: string[];
	screenshots?: boolean;
	collectMetadata?: (context: FeedbackMetadataContext) => unknown | Promise<unknown>;
	theme?: FeedbackTheme;
	placement?: FeedbackPlacement;
	maxPayloadBytes?: number;
	maxMetadataBytes?: number;
	metadataTimeoutMs?: number;
	screenshotScale?: number;
	fetch?: typeof fetch;
	onSubmit?: (result: { ok: boolean; status?: number; error?: string }) => void;
}
export interface FeedbackWidget {
	open(): void;
	close(): void;
	destroy(): void;
}
const REQUEST_LIMIT = 2 * 1024 * 1024;
const SCREENSHOT_LIMIT = 1536 * 1024;
const BUILTIN_PRIVATE = ['input[type="password"]', '[data-sentinel-feedback-private]'];
type Rect = NonNullable<FeedbackMetadataContext['geometry']>;

/** A bounded locator, never an HTML/text/value serialization. */
export function elementLocator(element: Element): string {
	const root = element.getRootNode() as Document | ShadowRoot;
	for (const attribute of ['id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'role']) {
		const value = element.getAttribute(attribute);
		if (!value || value.length > 160) continue;
		const selector = `[${attribute}="${CSS.escape(value)}"]`;
		if (root.querySelectorAll(selector).length === 1) return selector;
	}
	const parts: string[] = [];
	let node: Element | null = element;
	while (node && parts.length < 8) {
		const parent: Element | null = node.parentElement;
		const position = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
		parts.unshift(`${node.localName}:nth-child(${position})`);
		node = parent;
	}
	return parts.join(' > ').slice(0, 1000);
}
function rectFor(element: Element): Rect {
	const rect = element.getBoundingClientRect();
	return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
}
function pageUrl(): string {
	const url = new URL(location.href);
	url.username = '';
	url.password = '';
	url.hash = '';
	for (const key of [...url.searchParams.keys()]) {
		if (/(token|secret|password|passwd|auth|api[_-]?key|session|code)/i.test(key))
			url.searchParams.delete(key);
	}
	return url.href.slice(0, 2048);
}
function matches(element: Element, selectors: string[]): boolean {
	return selectors.some((selector) => element.matches(selector));
}
function allPageElements(host: Element): Element[] {
	const elements: Element[] = [];
	const visit = (root: Document | ShadowRoot) => {
		for (const element of root.querySelectorAll('*')) {
			if (element === host) continue;
			elements.push(element);
			if (element.shadowRoot) visit(element.shadowRoot);
		}
	};
	visit(document);
	return elements;
}
function privateRegions(host: Element, selectors: string[]): Rect[] {
	const elements = allPageElements(host);
	const privateElements = elements.filter((element) => matches(element, selectors));
	const regions: Rect[] = [];
	for (const element of privateElements) {
		// Include descendants' geometry so visible overflow cannot escape its mask.
		for (const descendant of [element, ...element.querySelectorAll('*')]) {
			const rect = rectFor(descendant);
			if (rect.width > 0 && rect.height > 0) regions.push(rect);
		}
		if (element.shadowRoot) {
			for (const descendant of element.shadowRoot.querySelectorAll('*'))
				regions.push(rectFor(descendant));
		}
	}
	return regions;
}
export function paintMasks(
	context: CanvasRenderingContext2D,
	rects: Rect[],
	scaleX: number,
	scaleY: number,
): void {
	context.fillStyle = '#111827';
	for (const rect of rects) {
		const x = Math.floor(rect.x * scaleX) - 1;
		const y = Math.floor(rect.y * scaleY) - 1;
		context.fillRect(x, y, Math.ceil(rect.width * scaleX) + 3, Math.ceil(rect.height * scaleY) + 3);
	}
}
function imageFrom(blob: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		const url = URL.createObjectURL(blob);
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Unable to load screenshot.'));
		};
		image.src = url;
	});
}
function encode(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => {
			if (!blob) reject(new Error('Unable to encode screenshot.'));
			else if (blob.size > SCREENSHOT_LIMIT) reject(new Error('Screenshot exceeds 1.5 MiB.'));
			else resolve(blob);
		}, 'image/png'),
	);
}
async function metadataFor(
	options: FeedbackWidgetOptions,
	context: FeedbackMetadataContext,
): Promise<unknown> {
	if (!options.collectMetadata) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			Promise.resolve().then(() => options.collectMetadata?.(context)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Metadata callback timed out.')),
					boundedNumber(options.metadataTimeoutMs, 1500, 100, 5000),
				);
			}),
		]);
		const serialized = serializeMetadata(
			value,
			boundedNumber(options.maxMetadataBytes, 8192, 128, 8192),
		);
		return serialized === undefined ? null : JSON.parse(serialized);
	} finally {
		clearTimeout(timer);
	}
}

export function installFeedbackWidget(options: FeedbackWidgetOptions): FeedbackWidget {
	if (typeof document === 'undefined' || !document.body)
		throw new Error('Feedback requires a browser document.');
	const connection = resolveConnection(options);
	const selectors = [...BUILTIN_PRIVATE, ...(options.privateSelectors ?? [])];
	for (const selector of selectors) document.querySelector(selector); // Reject unsafe configuration, never silently skip masks.
	const host = document.createElement('div');
	host.setAttribute('data-workers-sentinel-feedback', '');
	host.dataset.placement = options.placement ?? 'bottom-right';
	const shadow = host.attachShadow({ mode: 'open' });
	const style = document.createElement('style');
	if (options.styleNonce) style.nonce = options.styleNonce;
	style.textContent = STYLES;
	shadow.append(style);
	for (const [key, value] of Object.entries(options.theme ?? {})) {
		if (typeof value === 'string' && value.length <= 100)
			host.style.setProperty(`--wsf-${key}`, value);
	}
	const launcher = document.createElement('button');
	launcher.type = 'button';
	launcher.className = 'launcher';
	launcher.textContent = options.launcherLabel ?? 'Feedback';
	launcher.setAttribute('aria-label', options.launcherLabel ?? 'Feedback');
	shadow.append(launcher);
	document.documentElement.append(host);
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	let destroyed = false;
	let generation = 0;
	let panel: HTMLElement | undefined;
	let cleanupPicker: (() => void) | undefined;
	let priorFocus: HTMLElement | undefined;
	const close = () => {
		generation++;
		cleanupPicker?.();
		cleanupPicker = undefined;
		panel?.remove();
		panel = undefined;
		if (!destroyed) launcher.focus();
	};
	const open = () => {
		if (destroyed || panel) return;
		priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const version = ++generation;
		const current = () => !destroyed && version === generation;
		const section = document.createElement('section');
		panel = section;
		section.className = 'panel';
		section.setAttribute('role', 'dialog');
		section.setAttribute('aria-label', 'Send feedback');
		section.innerHTML = `<strong>Send feedback</strong>
			<label>What happened?<textarea class="description" maxlength="4000" rows="4"></textarea></label>
			<div class="actions"><button class="picker" type="button">Select an element</button><span class="locator">No element selected</span></div>
			<p>Review your description, then capture a best-effort page image. Private regions are masked.</p>
			<button class="capture" type="button" disabled>Capture screenshot</button>
			<div class="capture-status" role="status"></div>
			<div class="preview-wrap" hidden><canvas class="preview"></canvas></div>
			<div class="error" role="alert" hidden></div>
			<button class="text-only" type="button" hidden>Continue with text only</button>
			<div class="actions"><button class="cancel" type="button">Cancel</button><button class="submit" type="button">Send feedback</button></div>`;
		shadow.append(section);
		const description = section.querySelector<HTMLTextAreaElement>('.description')!;
		const pick = section.querySelector<HTMLButtonElement>('.picker')!;
		const capture = section.querySelector<HTMLButtonElement>('.capture')!;
		const send = section.querySelector<HTMLButtonElement>('.submit')!;
		const textOnly = section.querySelector<HTMLButtonElement>('.text-only')!;
		const error = section.querySelector<HTMLElement>('.error')!;
		const status = section.querySelector<HTMLElement>('.capture-status')!;
		const summary = section.querySelector<HTMLElement>('.locator')!;
		const preview = section.querySelector<HTMLCanvasElement>('.preview')!;
		let target: Element | undefined;
		let geometry: Rect | null = null;
		let locator = '';
		let screenshot: Blob | undefined;
		let withoutImage = false;
		let withoutMetadata = false;
		let busy = false;
		const showError = (message: string) => {
			error.textContent = message;
			error.hidden = false;
		};
		const setBusy = (value: boolean) => {
			if (!current()) return;
			busy = value;
			send.disabled = value;
			pick.disabled = value;
			capture.disabled = value || !target || options.screenshots === false;
			description.disabled = value;
		};
		textOnly.addEventListener('click', () => {
			withoutImage = true;
			screenshot = undefined;
			textOnly.hidden = true;
			error.hidden = true;
			status.textContent = 'Text-only report selected. Choose Send feedback to submit.';
		});
		if (options.screenshots === false) {
			capture.hidden = true;
			textOnly.hidden = false;
			status.textContent =
				'Screenshots are disabled. Explicitly choose text-only before submitting.';
		}
		const record = (element: Element) => {
			target = element;
			locator = elementLocator(element);
			geometry = rectFor(element);
			summary.textContent = locator;
			screenshot = undefined;
			withoutImage = false;
			section.querySelector<HTMLElement>('.preview-wrap')!.hidden = true;
			capture.disabled = options.screenshots === false;
			textOnly.hidden = options.screenshots !== false;
			status.textContent = 'Element selected. Review your description before capture.';
		};
		pick.addEventListener('click', () => {
			cleanupPicker?.();
			const highlight = document.createElement('div');
			highlight.className = 'highlight';
			highlight.hidden = true;
			shadow.append(highlight);
			let pending: Element | undefined;
			const widgetEvent = (event: Event) => event.composedPath().includes(host);
			const actual = (event: Event) =>
				event.composedPath().find((entry): entry is Element => entry instanceof Element);
			const stop = (event: Event) => {
				event.preventDefault();
				event.stopImmediatePropagation();
			};
			const move = (event: PointerEvent) => {
				const element = widgetEvent(event) ? undefined : actual(event);
				highlight.hidden = !element;
				if (!element) return;
				const rect = element.getBoundingClientRect();
				Object.assign(highlight.style, {
					left: `${rect.left}px`,
					top: `${rect.top}px`,
					width: `${rect.width}px`,
					height: `${rect.height}px`,
				});
			};
			const down = (event: PointerEvent) => {
				if (widgetEvent(event)) return;
				stop(event);
				pending = actual(event);
			};
			const up = (event: PointerEvent) => {
				if (!widgetEvent(event)) stop(event);
			};
			const click = (event: MouseEvent) => {
				if (widgetEvent(event)) return;
				stop(event);
				const selected = pending ?? actual(event);
				cleanup();
				if (selected) record(selected);
				pick.focus();
			};
			const key = (event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					stop(event);
					cleanup();
					status.textContent = 'Element selection cancelled.';
					pick.focus();
				}
			};
			const cleanup = () => {
				document.removeEventListener('pointermove', move, true);
				document.removeEventListener('pointerdown', down, true);
				document.removeEventListener('pointerup', up, true);
				document.removeEventListener('pointercancel', up, true);
				document.removeEventListener('click', click, true);
				document.removeEventListener('keydown', key, true);
				highlight.remove();
				cleanupPicker = undefined;
			};
			cleanupPicker = cleanup;
			document.addEventListener('pointermove', move, true);
			document.addEventListener('pointerdown', down, true);
			document.addEventListener('pointerup', up, true);
			document.addEventListener('pointercancel', up, true);
			document.addEventListener('click', click, true);
			document.addEventListener('keydown', key, true);
			status.textContent = 'Click a page element. Escape cancels.';
		});
		capture.addEventListener('click', async () => {
			if (busy || !target || !current()) return;
			if (!description.value.trim()) {
				showError('Enter and review a description before capture.');
				description.focus();
				return;
			}
			setBusy(true);
			screenshot = undefined;
			withoutImage = false;
			error.hidden = true;
			status.textContent = 'Capturing…';
			try {
				geometry = rectFor(target);
				const width = Math.max(
					document.documentElement.scrollWidth,
					document.body.scrollWidth,
					innerWidth,
				);
				const height = Math.max(
					document.documentElement.scrollHeight,
					document.body.scrollHeight,
					innerHeight,
				);
				const masks = privateRegions(host, selectors);
				const startScroll = [scrollX, scrollY];
				const blob = await toBlob(document.documentElement, {
					width,
					height,
					pixelRatio: Math.min(
						boundedNumber(options.screenshotScale, 1, 0.25, 2),
						2048 / width,
						2048 / height,
					),
					filter: (element: HTMLElement) => element !== host,
				});
				if (!current()) return;
				if (!blob) throw new Error('Renderer returned no image.');
				const image = await imageFrom(blob);
				if (!current()) return;
				if (
					startScroll[0] !== scrollX ||
					startScroll[1] !== scrollY ||
					width !==
						Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth) ||
					height !==
						Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)
				)
					throw new Error('Page geometry changed during capture. Please retry.');
				preview.width = image.naturalWidth;
				preview.height = image.naturalHeight;
				if (preview.width > 2048 || preview.height > 2048)
					throw new Error('Rendered image exceeds dimension limits.');
				const context = preview.getContext('2d');
				if (!context) throw new Error('Canvas is unavailable.');
				context.drawImage(image, 0, 0);
				const scaleX = preview.width / width;
				const scaleY = preview.height / height;
				paintMasks(context, masks, scaleX, scaleY);
				context.strokeStyle = '#e11d48';
				context.lineWidth = 3;
				context.strokeRect(
					geometry.x * scaleX,
					geometry.y * scaleY,
					geometry.width * scaleX,
					geometry.height * scaleY,
				);
				const encoded = await encode(preview);
				if (!current()) return;
				screenshot = encoded;
				section.querySelector<HTMLElement>('.preview-wrap')!.hidden = false;
				status.textContent =
					'Review the masked screenshot and selected-element outline before sending.';
			} catch (cause) {
				if (!current()) return;
				screenshot = undefined;
				textOnly.hidden = false;
				showError(
					`Capture failed: ${cause instanceof Error ? cause.message : 'unknown error'}. Choose Continue with text only to omit the image.`,
				);
			} finally {
				setBusy(false);
			}
		});
		send.addEventListener('click', async () => {
			if (busy || !current()) return;
			const text = description.value.trim();
			if (!text || text.length > 4000 || !locator) {
				showError('Select an element and enter a description of up to 4000 characters.');
				return;
			}
			if (!screenshot && !withoutImage) {
				showError('Capture an image, or explicitly choose text-only after capture failure.');
				return;
			}
			setBusy(true);
			error.hidden = true;
			const metadataContext: FeedbackMetadataContext = {
				pageUrl: pageUrl(),
				pageTitle: document.title.slice(0, 300),
				locator,
				description: text,
				geometry: geometry ? { ...geometry } : null,
			};
			let extra: unknown = null;
			try {
				if (!withoutMetadata) extra = await metadataFor(options, Object.freeze(metadataContext));
			} catch (cause) {
				if (!current()) return;
				showError(
					`Optional metadata failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
				);
				const continueButton = document.createElement('button');
				continueButton.type = 'button';
				continueButton.textContent = 'Continue without metadata';
				continueButton.addEventListener('click', () => {
					withoutMetadata = true;
					error.hidden = true;
					status.textContent = 'Extra metadata omitted. Choose Send feedback to continue.';
				});
				error.append(continueButton);
				setBusy(false);
				return;
			}
			if (!current()) return;
			try {
				const metadata = JSON.stringify({ ...metadataContext, metadata: extra });
				if (new TextEncoder().encode(metadata).length > 12 * 1024)
					throw new Error('Feedback metadata exceeds 12 KiB; shorten the description or metadata.');
				if (
					new TextEncoder().encode(metadata).length + (screenshot?.size ?? 0) + 4096 >
					boundedNumber(options.maxPayloadBytes, REQUEST_LIMIT, 16 * 1024, REQUEST_LIMIT)
				)
					throw new Error('Feedback exceeds the request byte limit.');
				const form = new FormData();
				form.set('metadata', metadata);
				if (screenshot) form.set('screenshot', screenshot, 'feedback.png');
				const response = await fetcher(
					`${connection.baseUrl}/api/${encodeURIComponent(connection.projectId)}/feedback?sentry_key=${encodeURIComponent(connection.publicKey)}`,
					{ method: 'POST', body: form, credentials: 'omit' },
				);
				if (!current()) return;
				if (!response.ok) throw new Error(`Feedback request failed with HTTP ${response.status}.`);
				section.replaceChildren();
				section.setAttribute('role', 'status');
				section.textContent = 'Thank you! Your feedback was sent.';
				options.onSubmit?.({ ok: true, status: response.status });
			} catch (cause) {
				if (!current()) return;
				const message = cause instanceof Error ? cause.message : 'Submission failed.';
				showError(message);
				options.onSubmit?.({ ok: false, error: message });
			} finally {
				setBusy(false);
			}
		});
		section.querySelector('.cancel')!.addEventListener('click', close);
		section.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !cleanupPicker) close();
		});
		description.focus();
	};
	launcher.addEventListener('click', open);
	return {
		open,
		close,
		destroy() {
			destroyed = true;
			close();
			host.remove();
			priorFocus?.focus();
		},
	};
}

const STYLES = `
:host{all:initial;position:fixed;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;pointer-events:none;color:var(--wsf-textColor,#172033)}
*,*::before,*::after{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--wsf-borderColor,#c7ced9);border-radius:8px;padding:9px 12px;background:var(--wsf-backgroundColor,#fff);color:var(--wsf-textColor,#172033)}button:disabled{opacity:.5;cursor:wait}
:host([data-placement="bottom-right"]){right:20px;bottom:20px}:host([data-placement="bottom-left"]){left:20px;bottom:20px}:host([data-placement="top-right"]){right:20px;top:20px}:host([data-placement="top-left"]){left:20px;top:20px}
.launcher,.panel{pointer-events:auto}.launcher,.submit{background:var(--wsf-accentColor,#c9234a);color:var(--wsf-accentTextColor,#fff)}.launcher{border-radius:999px}.panel{position:absolute;bottom:50px;right:0;width:min(420px,calc(100vw - 40px));max-height:calc(100vh - 90px);overflow:auto;background:var(--wsf-backgroundColor,#fff);padding:18px;border:1px solid var(--wsf-borderColor,#ddd);border-radius:12px;box-shadow:0 8px 40px #0004}:host([data-placement="bottom-left"]) .panel,:host([data-placement="top-left"]) .panel{left:0;right:auto}:host([data-placement="top-left"]) .panel,:host([data-placement="top-right"]) .panel{top:50px;bottom:auto}label{display:block;margin-top:12px}textarea{display:block;width:100%;padding:10px;margin-top:4px}.actions{display:flex;gap:10px;align-items:center;margin-top:12px}.locator{font-size:12px;overflow-wrap:anywhere}.error{background:#fff1f2;color:#9f1239;padding:10px;margin:10px 0}.capture-status{margin:8px 0}.preview{max-width:100%;max-height:220px}.highlight{position:fixed;pointer-events:none;border:2px solid #e11d48;background:#e11d4810}p{font-size:12px;color:var(--wsf-mutedColor,#667085)}
`;
