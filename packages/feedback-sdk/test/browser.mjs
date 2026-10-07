import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (request, response) => {
	try {
		if (request.url.startsWith('/dist/')) {
			response.setHeader('Content-Type', 'text/javascript');
			response.end(await readFile(path.join(root, 'dist', path.basename(request.url))));
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		const standalone = request.url.includes('script');
		response.end(`<!doctype html><html><head><title>SDK fixture</title><style nonce="fixture-nonce">
		body{margin:0;background:white;font:16px sans-serif}#target{position:absolute;left:40px;top:40px;width:180px;height:70px;background:#00cc44;border:0}#target span{display:block;width:100%;height:100%}.private{position:absolute;left:40px;width:180px;height:50px;background:#ff0000;color:white}#password{top:160px}#default-private{top:230px}#custom-private{top:300px;z-index:2147483647}
		</style></head><body><button id="target"><span data-testid="final-child">Pick nested child</span></button>
		<input id="password" class="private" type="password" value="secret-password">
		<div id="default-private" class="private" data-sentinel-feedback-private>PRIVATE DEFAULT</div>
		<div id="custom-private" class="private" data-private>PRIVATE HIGH Z</div>
		${standalone ? '<script src="/dist/browser.iife.js"></script>' : ''}
		<script ${standalone ? '' : 'type="module"'}>
		${standalone ? 'const install = window.WorkersSentinelFeedback.install;' : "import { installFeedbackWidget as install } from '/dist/index.js';"}
		window.activation=0;window.pointerActivation=0;window.pointerUpActivation=0;window.hookCalls=0;window.sent=[];
		document.querySelector('#target').onclick=()=>window.activation++;
		document.querySelector('#target').onpointerdown=()=>window.pointerActivation++;
		document.querySelector('#target').onpointerup=()=>window.pointerUpActivation++;
		window.makeWidget=(extra={})=>install({dsn:'http://public@127.0.0.1/project',launcherLabel:'Feedback',styleNonce:'fixture-nonce',privateSelectors:['[data-private]'],collectMetadata:async context=>{window.hookCalls++;window.hookContext=context;return {release:'browser-release'}},fetch:async (_url,request)=>{window.sent.push(request);return new Response('{}',{status:201})},...extra});
		window.widget=window.makeWidget();
		</script></body></html>`);
	} catch (error) {
		response.statusCode = 500;
		response.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
	for (const mode of ['esm', 'script']) {
		const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`${base}/${mode}`);
		await page.getByRole('button', { name: 'Feedback', exact: true }).click();
		assert.equal(await page.evaluate(() => window.hookCalls), 0);
		await page.getByRole('button', { name: 'Select an element' }).click();
		await page.keyboard.press('Escape');
		await page.locator('#target span').click();
		assert.equal(await page.evaluate(() => window.activation), 1);
		await page
			.getByRole('textbox', { name: 'What happened?' })
			.fill('The nested element needs improvement.');
		await page.getByRole('button', { name: 'Select an element' }).click();
		await page.locator('#target span').click();
		assert.equal(await page.evaluate(() => window.activation), 1);
		assert.equal(await page.evaluate(() => window.pointerActivation), 1);
		assert.equal(await page.evaluate(() => window.pointerUpActivation), 1);
		assert.match(await page.locator('.locator').textContent(), /final-child/);
		assert.equal(await page.locator('.preview-wrap').isVisible(), false);
		await page.getByRole('button', { name: 'Capture screenshot' }).click();
		await page.locator('.preview-wrap').waitFor({ state: 'visible' });
		const pixels = await page.evaluate(() => {
			const canvas = document
				.querySelector('[data-workers-sentinel-feedback]')
				.shadowRoot.querySelector('canvas');
			const ctx = canvas.getContext('2d');
			return [
				...['password', 'default-private', 'custom-private'].map((id) => {
					const rect = document.querySelector(`#${id}`).getBoundingClientRect();
					return [
						...ctx.getImageData(
							((rect.left + 10) * canvas.width) / innerWidth,
							((rect.top + 10) * canvas.height) / innerHeight,
							1,
							1,
						).data,
					];
				}),
				(() => {
					const rect = document.querySelector('#target span').getBoundingClientRect();
					return [
						...ctx.getImageData(
							(rect.left * canvas.width) / innerWidth,
							((rect.top + 10) * canvas.height) / innerHeight,
							1,
							1,
						).data,
					];
				})(),
			];
		});
		for (const masked of pixels.slice(0, 3)) assert.deepEqual(masked, [17, 24, 39, 255]);
		assert.ok(pixels[3][0] > 150 && pixels[3][1] < 80, `annotation pixel ${pixels[3]}`);
		await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
		await page.getByText('Thank you! Your feedback was sent.').waitFor();
		const submitted = await page.evaluate(async () => {
			const request = window.sent[0];
			return {
				metadata: JSON.parse(request.body.get('metadata')),
				imageType: request.body.get('screenshot').type,
				credentials: request.credentials,
				context: window.hookContext,
			};
		});
		assert.equal(submitted.credentials, 'omit');
		assert.equal(submitted.imageType, 'image/png');
		assert.equal(submitted.metadata.metadata.release, 'browser-release');
		assert.equal(submitted.context.description, 'The nested element needs improvement.');
		assert.equal(await page.evaluate(() => window.hookCalls), 1);
		assert.deepEqual(errors, []);
		await page.close();
		console.log(
			`PASS ${mode}: installer, final-element picker, Escape, consent, mask pixels, annotation, metadata, multipart`,
		);
	}
	const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
	await page.goto(`${base}/esm`);
	await page.evaluate(() => {
		window.widget.destroy();
		window.widget = window.makeWidget({
			screenshots: false,
			collectMetadata: async () => {
				throw new Error('hook failure');
			},
		});
	});
	await page.getByRole('button', { name: 'Feedback', exact: true }).click();
	await page.getByRole('textbox', { name: 'What happened?' }).fill('Text only feedback');
	await page.getByRole('button', { name: 'Select an element' }).click();
	await page.locator('#target span').click();
	await page.getByRole('button', { name: 'Continue with text only' }).click();
	await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
	await page.getByRole('button', { name: 'Continue without metadata' }).waitFor();
	assert.equal(await page.evaluate(() => window.sent.length), 0);
	await page.getByRole('button', { name: 'Continue without metadata' }).click();
	assert.equal(await page.evaluate(() => window.sent.length), 0);
	await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
	await page.getByText('Thank you! Your feedback was sent.').waitFor();
	assert.equal(await page.evaluate(() => window.sent[0].body.has('screenshot')), false);
	console.log('PASS explicit text-only and metadata-failure choice');
	await page.close();
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
