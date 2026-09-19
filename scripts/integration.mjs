#!/usr/bin/env node
// Stand up an isolated wrangler dev environment and run the black-box
// integration suite against it. Owns its port, its Durable Object
// persistence (under a temp dir), and its environment bindings — it never
// touches the guarded supervisor's state in _devenv/ or its port.
//
// Usage: node scripts/integration.mjs
// Exit code: the node --test exit code (non-zero on any failure).
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETUP_TOKEN = 'integration-setup-token';
const READINESS_TIMEOUT_MS = 180_000;

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitForHealth(baseUrl, isAlive, deadline) {
	while (Date.now() < deadline) {
		if (isAlive.exited !== null) {
			throw new Error(`wrangler dev exited early (code ${isAlive.exited})`);
		}
		try {
			const response = await fetch(`${baseUrl}/api/health`, {
				signal: AbortSignal.timeout(1500),
			});
			if (response.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error('wrangler dev readiness timed out');
}

function stopGroup(child) {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		child.once('exit', done);
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			done();
		}
		setTimeout(() => {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				/* already gone */
			}
		}, 5000).unref();
	});
}

const workDir = await mkdtemp(path.join(tmpdir(), 'sentinel-integration-'));
const logFile = await open(path.join(workDir, 'wrangler.log'), 'w');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_|DOCKER_)/.test(key)),
);
Object.assign(env, {
	WRANGLER_SEND_METRICS: 'false',
	CI: 'true',
	SETUP_TOKEN,
});

const isAlive = { exited: null };
const wrangler = spawn(
	'mise',
	[
		'exec',
		'npm:pnpm@10.24.0',
		'--',
		'pnpm',
		'--dir',
		'packages/workers-sentinel',
		'exec',
		'wrangler',
		'dev',
		'--port',
		String(port),
		'--ip',
		'127.0.0.1',
		'--persist-to',
		path.join(workDir, 'persist'),
		// Process env does not become Worker bindings under wrangler dev;
		// --var is the local-dev mechanism.
		'--var',
		`SETUP_TOKEN:${SETUP_TOKEN}`,
	],
	{
		cwd: ROOT,
		env,
		stdio: ['ignore', logFile.fd, logFile.fd],
		detached: true,
	},
);
wrangler.on('error', (error) => {
	isAlive.exited = -1;
	console.error('failed to spawn wrangler:', error.message);
});
wrangler.on('exit', (code) => {
	isAlive.exited = code;
});

let testCode = 1;
try {
	process.stdout.write(`integration: waiting for ${baseUrl} ... `);
	await waitForHealth(baseUrl, isAlive, Date.now() + READINESS_TIMEOUT_MS);
	console.log('ready');

	const tests = spawn('node', ['--test', 'packages/workers-sentinel/integration/'], {
		cwd: ROOT,
		env: { ...process.env, SENTINEL_INTEGRATION_URL: baseUrl, SENTINEL_SETUP_TOKEN: SETUP_TOKEN },
		stdio: 'inherit',
	});
	testCode = await new Promise((resolve) => {
		tests.on('error', (error) => {
			console.error('failed to spawn node --test:', error.message);
			resolve(1);
		});
		tests.on('exit', (code) => resolve(code ?? 1));
	});
} catch (error) {
	console.error(`\nintegration environment failed: ${error.message}`);
	const { readFile } = await import('node:fs/promises');
	try {
		const log = await readFile(path.join(workDir, 'wrangler.log'), 'utf8');
		const tail = log.split('\n').slice(-40).join('\n');
		console.error('--- wrangler log tail ---\n' + tail);
	} catch {
		/* log unavailable */
	}
	testCode = 1;
} finally {
	await stopGroup(wrangler);
	await logFile.close();
	await rm(workDir, { recursive: true, force: true });
}

process.exit(testCode);
