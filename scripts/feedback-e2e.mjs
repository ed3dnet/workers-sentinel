// Local-only browser-to-Worker-to-dashboard verification. Start an isolated
// local Worker first; never point this test at a shared or deployed instance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.SENTINEL_FEEDBACK_URL;
if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) {
	throw new Error('Set SENTINEL_FEEDBACK_URL to an isolated loopback Worker.');
}
const setupToken = process.env.SENTINEL_FEEDBACK_SETUP_TOKEN;
const sdk = fileURLToPath(new URL('../packages/feedback-sdk/', import.meta.url));
const { chromium } = await import(path.join(sdk, 'node_modules/playwright/index.mjs'));
const run = `feedback-e2e-${Date.now()}`;
async function jsonApi(route, method, body, token) {
	const response = await fetch(`${base}${route}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await response.json();
	assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
	return data;
}
const account = await jsonApi('/api/auth/register', 'POST', {
	email: `${run}@example.com`,
	password: 'local-feedback-test-password',
	name: 'Feedback E2E',
	setupToken,
});
const { project } = await jsonApi('/api/projects', 'POST', { name: run }, account.token);
const dsn = `${base.replace('://', `://${project.publicKey}@`)}/${project.id}`;
const server = createServer(async (request, response) => {
	try {
		if (request.url?.startsWith('/dist/')) {
			const filename = path.basename(request.url);
			response.setHeader('Content-Type', 'text/javascript');
			response.end(await readFile(path.join(sdk, 'dist', filename)));
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(`<!doctype html><html><head><title>Feedback browser integration</title></head><body style="margin:0;background:white">
			<button id="target" style="margin:40px;width:180px;height:60px">Pick this button</button>
			<div data-sentinel-feedback-private style="background:red;width:160px;height:50px">PRIVATE CONTENT</div>
			<script type="module">
			import { installFeedbackWidget } from '/dist/index.js';
			window.pageActivations = 0;
			document.querySelector('#target').addEventListener('click', () => window.pageActivations++);
			window.widget = installFeedbackWidget({ dsn: ${JSON.stringify(dsn)}, collectMetadata: async () => ({ release: 'e2e-release' }) });
			</script></body></html>`);
	} catch (error) {
		response.statusCode = 500;
		response.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const website = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
	await page.goto(website);
	await page.getByRole('button', { name: 'Feedback', exact: true }).click();
	assert.equal(await page.getByRole('dialog').count(), 0);
	await page.locator('#target').click();
	assert.equal(await page.evaluate(() => window.pageActivations), 0);
	await page.getByRole('textbox').fill('Actual browser feedback reaches the protected dashboard.');
	await page.waitForFunction(
		() =>
			!document
				.querySelector('[data-workers-sentinel-feedback]')
				.shadowRoot.querySelector('.preview-wrap').hidden,
	);
	const submission = page.waitForResponse(
		(response) =>
			response.url().includes(`/api/${project.id}/feedback`) &&
			response.request().method() === 'POST',
	);
	await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
	assert.equal((await submission).status(), 201);
	const list = await jsonApi(
		`/api/projects/${project.slug}/feedback`,
		'GET',
		undefined,
		account.token,
	);
	assert.equal(list.feedback.length, 1);
	assert.equal(list.feedback[0].metadata.release, 'e2e-release');
	assert.ok(list.feedback[0].screenshotType);
	const id = list.feedback[0].id;
	const unauthorized = await fetch(
		`${base}/api/projects/${project.slug}/feedback/${id}/screenshot`,
	);
	assert.equal(unauthorized.status, 401);
	await page.goto(base);
	await page.evaluate((token) => localStorage.setItem('token', token), account.token);
	const imageRequest = page.waitForRequest((request) =>
		request.url().endsWith(`/feedback/${id}/screenshot`),
	);
	await page.goto(`${base}/projects/${project.slug}/feedback/${id}`);
	const request = await imageRequest;
	assert.equal(request.headers().authorization, `Bearer ${account.token}`);
	await page.locator('img[src^="blob:"]').waitFor();
	await page.waitForFunction(() => {
		const image = document.querySelector('img[src^="blob:"]');
		return image?.complete && image.naturalWidth > 0;
	});
	assert.ok(
		await page.getByText('Actual browser feedback reaches the protected dashboard.').isVisible(),
	);
	console.log(
		'PASS: cross-origin SDK capture/submission → stored metadata → member-only bearer screenshot → dashboard Blob preview',
	);
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
