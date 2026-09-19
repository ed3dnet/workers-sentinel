// CLI for the guarded local supervisor; backs `just dev-up/dev-down/dev-reset/
// smoke`. Local-only: it never invokes remote Wrangler and strips Cloudflare
// credentials from children. Remote deployment is intentionally not a command
// here; it is deferred to wrangler's own interactive login when needed.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveControl } from './control.mjs';
import { localLayout, reset, start } from './local.mjs';

export function assertCommand(command, mode) {
	if (mode !== 'dev') throw new Error('Only local dev mode is permitted');
	if (!['up', 'down', 'reset', 'smoke'].includes(command)) {
		throw new Error('Unknown command; only up/down/reset/smoke exist (local-only)');
	}
}

export async function main(args) {
	const [command, mode = 'dev', confirmation] = args;
	assertCommand(command, mode);
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const info = await localLayout(root, mode);
	const control = resolve(info.state, 'control.json');
	if (command === 'reset') {
		if (confirmation !== '--confirm-local-reset')
			throw new Error('Reset requires --confirm-local-reset');
		return reset(info);
	}
	if (command === 'down') {
		const { port, token } = JSON.parse(await readFile(control, 'utf8'));
		if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) {
			throw new Error('Invalid control record; reconcile manually, never kill a recorded PID');
		}
		const response = await fetch(`http://127.0.0.1:${port}/stop`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30000),
		});
		if (!response.ok) throw new Error('Live supervisor rejected stop; no PID was signalled');
		return;
	}
	if (command === 'smoke') {
		for (const url of [
			`http://${info.host}:${info.port}/api/health`,
			`http://${info.host}:${info.port}/`,
		]) {
			if (!(await fetch(url, { signal: AbortSignal.timeout(10000) })).ok) {
				throw new Error(`Smoke failed: ${url}`);
			}
		}
		console.log('HTTP smoke passed (health + dashboard assets)');
		return;
	}
	const running = await start({ root, mode });
	await serveControl(running, control);
	console.log(`Ready: http://${info.host}:${info.port}`);
	console.log(
		`Dashboard: http://${info.host}:${info.port}/projects | ingestion: POST /api/{projectId}/envelope/`,
	);
	console.log('Stop with just dev-down from another terminal (keep this one open)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
