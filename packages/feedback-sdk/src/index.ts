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
function privateRegions(privateElements: Element[]): Rect[] {
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
			boundedNumber(options.maxMetadataBytes, 8192, 1, 8192),
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
	const notifySubmit = (result: Parameters<NonNullable<FeedbackWidgetOptions['onSubmit']>>[0]) => {
		try {
			void Promise.resolve(options.onSubmit?.(result)).catch(() => {
				// Async application notifications are also independent of submission.
			});
		} catch {
			// Application notifications must not change the confirmed submission result.
		}
	};
	let destroyed = false;
	let active = false;
	let generation = 0;
	let panel: HTMLElement | undefined;
	let waiting: HTMLElement | undefined;
	let cleanupPicker: (() => void) | undefined;
	let cleanupWaiting: (() => void) | undefined;

	const currentFor = (version: number) => !destroyed && active && version === generation;
	const hideWaiting = () => {
		cleanupWaiting?.();
		cleanupWaiting = undefined;
		waiting?.remove();
		waiting = undefined;
	};
	const close = () => {
		generation++;
		active = false;
		cleanupPicker?.();
		cleanupPicker = undefined;
		hideWaiting();
		panel?.remove();
		panel = undefined;
		if (!destroyed) launcher.focus();
	};
	const showWaiting = (message: string, version: number) => {
		hideWaiting();
		const surface = document.createElement('div');
		surface.className = 'waiting';
		surface.setAttribute('role', 'status');
		surface.setAttribute('aria-live', 'polite');
		const text = document.createElement('span');
		text.className = 'waiting-message';
		text.textContent = message;
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'waiting-cancel';
		cancel.textContent = 'Cancel';
		cancel.setAttribute('aria-label', 'Cancel feedback');
		cancel.addEventListener('click', close);
		surface.append(text, cancel);
		shadow.append(surface);
		waiting = surface;
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !currentFor(version)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		};
		document.addEventListener('keydown', key, true);
		cleanupWaiting = () => document.removeEventListener('keydown', key, true);
		cancel.focus();
	};

	const captureElement = async (
		element: Element,
	): Promise<{
		blob: Blob;
		canvas: HTMLCanvasElement;
		geometry: Rect;
	}> => {
		const geometry = rectFor(element);
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
		const privateElements = allPageElements(host).filter((element) => matches(element, selectors));
		const excluded = new Set(privateElements);
		if (excluded.has(document.documentElement))
			throw new Error('The page root is private; screenshot omitted.');
		const masks = privateRegions(privateElements);
		const startScroll = [scrollX, scrollY];
		const blob = await toBlob(document.documentElement, {
			width,
			height,
			pixelRatio: Math.min(
				boundedNumber(options.screenshotScale, 1, 0.25, 2),
				2048 / width,
				2048 / height,
			),
			filter: (candidate: HTMLElement) =>
				!(candidate instanceof Element) ||
				(candidate !== host && !excluded.has(candidate) && !matches(candidate, selectors)),
		});
		if (!blob) throw new Error('Renderer returned no image.');
		const image = await imageFrom(blob);
		if (
			startScroll[0] !== scrollX ||
			startScroll[1] !== scrollY ||
			width !==
				Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth) ||
			height !==
				Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)
		)
			throw new Error('Page geometry changed during capture. Please retry.');
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		if (canvas.width > 2048 || canvas.height > 2048)
			throw new Error('Rendered image exceeds dimension limits.');
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable.');
		context.drawImage(image, 0, 0);
		const scaleX = canvas.width / width;
		const scaleY = canvas.height / height;
		paintMasks(context, masks, scaleX, scaleY);
		context.strokeStyle = '#e11d48';
		context.lineWidth = 3;
		context.strokeRect(
			geometry.x * scaleX,
			geometry.y * scaleY,
			geometry.width * scaleX,
			geometry.height * scaleY,
		);
		return { blob: await encode(canvas), canvas, geometry };
	};

	const renderForm = (
		locator: string,
		geometry: Rect,
		descriptionText: string,
		image?: { blob: Blob; canvas: HTMLCanvasElement },
		captureWarning?: string,
	) => {
		const formVersion = generation;
		const section = document.createElement('section');
		panel = section;
		section.className = 'panel';
		section.setAttribute('role', 'dialog');
		section.setAttribute('aria-label', 'Send feedback');
		section.innerHTML = `<strong>Send feedback</strong>
			<label>What happened?<textarea class="description" maxlength="4000" rows="4"></textarea></label>
			<div class="actions"><span class="locator"></span><button class="reselect" type="button">Reselect element</button></div>
			<div class="capture-status" role="status" aria-live="polite"></div>
			<div class="preview-wrap" hidden><canvas class="preview"></canvas></div>
			<div class="error" role="alert" hidden></div>
			<div class="actions"><button class="cancel" type="button">Cancel</button><button class="submit" type="button">Send feedback</button></div>`;
		shadow.append(section);
		const description = section.querySelector<HTMLTextAreaElement>('.description')!;
		const send = section.querySelector<HTMLButtonElement>('.submit')!;
		const reselect = section.querySelector<HTMLButtonElement>('.reselect')!;
		const cancel = section.querySelector<HTMLButtonElement>('.cancel')!;
		const error = section.querySelector<HTMLElement>('.error')!;
		const status = section.querySelector<HTMLElement>('.capture-status')!;
		const summary = section.querySelector<HTMLElement>('.locator')!;
		const previewWrap = section.querySelector<HTMLElement>('.preview-wrap')!;
		const preview = section.querySelector<HTMLCanvasElement>('.preview')!;
		const screenshot = image?.blob;
		let withoutMetadata = false;
		let busy = false;
		description.value = descriptionText;
		summary.textContent = locator;
		if (image) {
			preview.width = image.canvas.width;
			preview.height = image.canvas.height;
			const context = preview.getContext('2d');
			if (context) context.drawImage(image.canvas, 0, 0);
			previewWrap.hidden = false;
			status.textContent =
				'Screenshot captured with private regions masked. Review it before sending.';
		} else if (options.screenshots === false) {
			status.textContent = 'Screenshots are disabled. Send feedback will submit without an image.';
		} else {
			status.textContent = 'Screenshot unavailable. Send feedback will submit without an image.';
		}
		if (captureWarning) {
			error.textContent = `Screenshot capture failed: ${captureWarning}. You can still send this report without an image.`;
			error.hidden = false;
		}
		const showError = (message: string) => {
			error.textContent = message;
			error.hidden = false;
		};
		const setBusy = (value: boolean) => {
			busy = value;
			send.disabled = value;
			reselect.disabled = value;
			description.disabled = value;
		};
		reselect.addEventListener('click', () => {
			if (!busy && currentFor(formVersion)) beginSelection(description.value);
		});
		cancel.addEventListener('click', close);
		section.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') close();
		});
		send.addEventListener('click', async () => {
			if (busy || !currentFor(formVersion)) return;
			const text = description.value.trim();
			if (!text || text.length > 4000 || !locator) {
				showError('Select an element and enter a description of up to 4000 characters.');
				return;
			}
			setBusy(true);
			error.hidden = true;
			const metadataContext: FeedbackMetadataContext = {
				pageUrl: pageUrl(),
				pageTitle: document.title.slice(0, 300),
				locator,
				description: text,
				geometry: { ...geometry },
			};
			let extra: unknown = null;
			try {
				if (!withoutMetadata) extra = await metadataFor(options, Object.freeze(metadataContext));
			} catch (cause) {
				if (!currentFor(formVersion)) return;
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
			if (!currentFor(formVersion)) return;
			try {
				const metadata = JSON.stringify({ ...metadataContext, metadata: extra });
				if (new TextEncoder().encode(metadata).length > 12 * 1024)
					throw new Error('Feedback metadata exceeds 12 KiB; shorten the description or metadata.');
				if (
					new TextEncoder().encode(metadata).length + (screenshot?.size ?? 0) + 4096 >
					boundedNumber(options.maxPayloadBytes, REQUEST_LIMIT, 1, REQUEST_LIMIT)
				)
					throw new Error('Feedback exceeds the request byte limit.');
				const form = new FormData();
				form.set('metadata', metadata);
				if (screenshot) form.set('screenshot', screenshot, 'feedback.png');
				const response = await fetcher(
					`${connection.baseUrl}/api/${encodeURIComponent(connection.projectId)}/feedback?sentry_key=${encodeURIComponent(connection.publicKey)}`,
					{ method: 'POST', body: form, credentials: 'omit' },
				);
				if (!currentFor(formVersion)) return;
				if (!response.ok) throw new Error(`Feedback request failed with HTTP ${response.status}.`);
				section.replaceChildren();
				section.setAttribute('role', 'status');
				section.setAttribute('aria-live', 'polite');
				section.innerHTML = `<strong>Thank you! Your feedback was sent.</strong>
					<div class="actions"><button class="close-success" type="button">Close</button><button class="another" type="button">Send another report</button></div>`;
				section
					.querySelector<HTMLButtonElement>('.close-success')!
					.addEventListener('click', close);
				section
					.querySelector<HTMLButtonElement>('.another')!
					.addEventListener('click', () => beginSelection(''));
				notifySubmit({ ok: true, status: response.status });
			} catch (cause) {
				if (!currentFor(formVersion)) return;
				const message = cause instanceof Error ? cause.message : 'Submission failed.';
				showError(message);
				notifySubmit({ ok: false, error: message });
			} finally {
				if (currentFor(formVersion)) setBusy(false);
			}
		});
		description.focus();
	};

	const startCapture = async (element: Element, version: number, descriptionText: string) => {
		const locator = elementLocator(element);
		const geometry = rectFor(element);
		if (options.screenshots === false) {
			if (currentFor(version)) renderForm(locator, geometry, descriptionText);
			return;
		}
		showWaiting('Capturing a masked screenshot. Press Escape or Cancel to stop.', version);
		try {
			const image = await captureElement(element);
			if (!currentFor(version)) return;
			hideWaiting();
			renderForm(locator, image.geometry, descriptionText, image);
		} catch (cause) {
			if (!currentFor(version)) return;
			hideWaiting();
			renderForm(
				locator,
				geometry,
				descriptionText,
				undefined,
				cause instanceof Error ? cause.message : 'unknown error',
			);
		}
	};

	function beginSelection(descriptionText: string) {
		if (destroyed || !active) return;
		generation++;
		const version = generation;
		cleanupPicker?.();
		cleanupPicker = undefined;
		hideWaiting();
		panel?.remove();
		panel = undefined;
		showWaiting('Select a page element. Press Escape or Cancel to stop.', version);
		const highlight = document.createElement('div');
		highlight.className = 'highlight';
		highlight.hidden = true;
		shadow.append(highlight);
		const pathElement = (event: Event): Element | undefined => {
			const path = event.composedPath();
			if (path.includes(host)) return undefined;
			return path.find((entry): entry is Element => entry instanceof Element);
		};
		const stop = (event: Event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		const move = (event: PointerEvent) => {
			const element = pathElement(event);
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
			if (!event.composedPath().includes(host)) stop(event);
		};
		const up = (event: PointerEvent) => {
			if (!event.composedPath().includes(host)) stop(event);
		};
		const click = (event: MouseEvent) => {
			const selected = pathElement(event);
			if (!event.composedPath().includes(host)) stop(event);
			if (!selected || !currentFor(version)) return;
			cleanup();
			hideWaiting();
			void startCapture(selected, version, descriptionText);
		};
		const cleanup = () => {
			document.removeEventListener('pointermove', move, true);
			document.removeEventListener('pointerdown', down, true);
			document.removeEventListener('pointerup', up, true);
			document.removeEventListener('pointercancel', up, true);
			document.removeEventListener('click', click, true);
			highlight.remove();
			cleanupPicker = undefined;
		};
		cleanupPicker = cleanup;
		document.addEventListener('pointermove', move, true);
		document.addEventListener('pointerdown', down, true);
		document.addEventListener('pointerup', up, true);
		document.addEventListener('pointercancel', up, true);
		document.addEventListener('click', click, true);
	}

	const open = () => {
		if (destroyed || active) return;
		active = true;
		beginSelection('');
	};
	launcher.addEventListener('click', open);
	return {
		open,
		close,
		destroy() {
			destroyed = true;
			close();
			host.remove();
		},
	};
}

const STYLES = `
:host{all:initial;position:fixed;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;pointer-events:none;color:var(--wsf-textColor,#172033)}
*,*::before,*::after{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;border:1px solid var(--wsf-borderColor,#c7ced9);border-radius:8px;padding:9px 12px;background:var(--wsf-backgroundColor,#fff);color:var(--wsf-textColor,#172033)}button:disabled{opacity:.5;cursor:wait}
:host([data-placement="bottom-right"]){right:20px;bottom:20px}:host([data-placement="bottom-left"]){left:20px;bottom:20px}:host([data-placement="top-right"]){right:20px;top:20px}:host([data-placement="top-left"]){left:20px;top:20px}
.launcher,.panel,.waiting{pointer-events:auto}.launcher,.submit{background:var(--wsf-accentColor,#c9234a);color:var(--wsf-accentTextColor,#fff)}.launcher{border-radius:999px}.panel{position:absolute;bottom:50px;right:0;width:min(420px,calc(100vw - 40px));max-height:calc(100vh - 90px);overflow:auto;background:var(--wsf-backgroundColor,#fff);padding:18px;border:1px solid var(--wsf-borderColor,#ddd);border-radius:12px;box-shadow:0 8px 40px #0004}:host([data-placement="bottom-left"]) .panel,:host([data-placement="top-left"]) .panel{left:0;right:auto}:host([data-placement="top-left"]) .panel,:host([data-placement="top-right"]) .panel{top:50px;bottom:auto}.waiting{position:absolute;bottom:50px;right:0;width:min(360px,calc(100vw - 40px));display:flex;gap:12px;align-items:center;justify-content:space-between;background:var(--wsf-backgroundColor,#fff);padding:12px;border:1px solid var(--wsf-borderColor,#ddd);border-radius:10px;box-shadow:0 8px 40px #0004}.waiting-message{flex:1}.waiting-cancel{white-space:nowrap}:host([data-placement="bottom-left"]) .waiting,:host([data-placement="top-left"]) .waiting{left:0;right:auto}:host([data-placement="top-left"]) .waiting,:host([data-placement="top-right"]) .waiting{top:50px;bottom:auto}label{display:block;margin-top:12px}textarea{display:block;width:100%;padding:10px;margin-top:4px}.actions{display:flex;gap:10px;align-items:center;margin-top:12px}.locator{font-size:12px;overflow-wrap:anywhere;flex:1}.error{background:#fff1f2;color:#9f1239;padding:10px;margin:10px 0}.capture-status{margin:8px 0}.preview{max-width:100%;max-height:220px}.highlight{position:fixed;pointer-events:none;border:2px solid #e11d48;background:#e11d4810}p{font-size:12px;color:var(--wsf-mutedColor,#667085)}
`;
