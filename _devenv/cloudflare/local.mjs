// Guarded local supervisor for workers-sentinel, ported from the
// ed3dsite-2025 _devenv/cloudflare pattern and scaled to this repository:
// one Worker, two SQLite Durable Objects, static dashboard assets. No Docker,
// no D1, no Mailpit and no generated configs are involved. All state is
// repo-owned under _devenv/cloudflare/.state and never leaves the machine:
// child processes are spawned with CLOUDFLARE_*/CF_*/WRANGLER_*/DOCKER_*
// variables stripped, so the supervisor cannot reach Cloudflare even if
// credentials exist in the parent environment.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const WRANGLER_DIR = 'packages/workers-sentinel';
// The repo config is JSONC; these text guards keep it local-only without a
// full JSONC parser. Wrangler itself parses the file properly.
function assertLocalConfig(text) {
	if (/\baccount_id\b/.test(text)) {
		throw new Error('wrangler.jsonc must not declare account_id for local dev');
	}
	if (/"remote"\s*:\s*true/.test(text)) {
		throw new Error('wrangler.jsonc must not enable remote dev');
	}
	// Routes: Workers custom-domain entries are deploy-time-only declarations
	// and inert under `wrangler dev --local`, so they may live in the repo
	// config. Zone-level route patterns (bare strings or entries without
	// custom_domain: true) stay forbidden.
	const routesMatch = text.match(/"routes"\s*:\s*(\[[\s\S]*?\])/);
	if (routesMatch) {
		const entries = routesMatch[1].match(/\{[^{}]*\}/g) ?? [];
		if (entries.length === 0) {
			throw new Error('wrangler.jsonc must not declare zone routes for local dev');
		}
		for (const entry of entries) {
			if (!/"custom_domain"\s*:\s*true/.test(entry)) {
				throw new Error(
					'Only custom_domain route entries are allowed in the repo config; zone routes are remote-only',
				);
			}
		}
	}
}

export function layout(root, mode = 'dev') {
	if (mode !== 'dev') throw new Error('Only local dev mode is supported');
	if (!path.isAbsolute(root)) throw new Error('Canonical absolute worktree root required');
	const hash = createHash('sha256').update(root).digest('hex');
	const override = Number.parseInt(process.env.SENTINEL_LOCAL_PORT ?? '', 10);
	const port =
		Number.isInteger(override) && override >= 1024 && override <= 65535
			? override
			: 20000 + (Number.parseInt(hash.slice(0, 8), 16) % 6000) * 2;
	const state = path.join(root, '_devenv/cloudflare/.state', mode);
	return {
		root,
		mode,
		host: '127.0.0.1',
		port,
		state,
		persist: path.join(state, 'persist'),
		inventory: path.join(state, 'inventory.json'),
		lock: path.join(state, 'lock'),
		wranglerDir: path.join(root, WRANGLER_DIR),
	};
}

export async function localLayout(root, mode) {
	return layout(await realpath(root), mode);
}

export function assertResetTarget(info, target) {
	const expected = layout(info.root, info.mode);
	if (info.state !== expected.state || path.resolve(target) !== expected.state) {
		throw new Error('Refusing non-local state reset');
	}
}

async function noSymlinks(root, target) {
	const relative = path.relative(root, target);
	if (relative.startsWith('..') || path.isAbsolute(relative))
		throw new Error('Path escapes worktree');
	let cursor = root;
	for (const part of relative.split(path.sep)) {
		cursor = path.join(cursor, part);
		try {
			if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink refused: ${cursor}`);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
}

export async function reset(info) {
	assertResetTarget(info, info.state);
	await noSymlinks(info.root, info.state);
	await mkdir(info.state, { recursive: true });
	// An exclusive lock refuses active and stale runs alike; never kill a recorded PID.
	await mkdir(info.lock);
	try {
		const entries = await readdir(info.state);
		if (entries.includes('inventory.json')) {
			throw new Error('Inventory exists: reconcile the recorded run before reset');
		}
		for (const entry of entries) {
			if (entry !== 'lock') await rm(path.join(info.state, entry), { recursive: true });
		}
	} finally {
		await rm(info.lock, { recursive: true });
	}
}

async function checkPort(port) {
	await new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
}

async function healthy(url) {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' })).ok;
	} catch {
		return false;
	}
}

/**
 * Start the guarded local supervisor. Spawns wrangler dev (local Workerd,
 * loopback-only, repo-owned persistence), waits for /api/health readiness,
 * then keeps a 1s health tick (3 consecutive misses stop the supervisor).
 * Returns layout info plus runId, stop() and a done promise. The lock and
 * inventory are removed only on clean stop; a stale inventory always requires
 * manual reconciliation.
 */
export async function start({ root, mode = 'dev', timeoutMs = 180000 }) {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
		throw new Error('Readiness timeout must be 1s-10min (first dashboard build takes a while)');
	}
	const info = await localLayout(root, mode);
	await noSymlinks(info.root, info.state);
	const configPath = path.join(info.wranglerDir, 'wrangler.jsonc');
	assertLocalConfig(await readFile(configPath, 'utf8'));
	await mkdir(info.state, { recursive: true });
	await mkdir(info.lock);
	const runId = randomUUID();
	let child;
	let timer;
	let stopping;
	let childExited = false;
	const inventory = {
		version: 1,
		...info,
		runId,
		supervisorPid: process.pid,
		childPid: null,
		ready: false,
		startedAt: new Date().toISOString(),
	};
	let writes = Promise.resolve();
	const save = () => {
		const contents = `${JSON.stringify(inventory, null, 2)}\n`;
		writes = writes.then(async () => {
			const temp = `${info.inventory}.${runId}.tmp`;
			const handle = await open(temp, 'w', 0o600);
			try {
				await handle.writeFile(contents);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temp, info.inventory);
			const directory = await open(info.state, 'r');
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		});
		return writes;
	};
	let finish;
	const done = new Promise((resolve) => {
		finish = resolve;
	});
	const stop = () => {
		if (!stopping) {
			stopping = (async () => {
				clearTimeout(timer);
				process.off('SIGINT', signalStop);
				process.off('SIGTERM', signalStop);
				if (child && !childExited) {
					const exited = new Promise((resolve) => child.once('exit', resolve));
					try {
						process.kill(-child.pid, 'SIGTERM');
					} catch (error) {
						if (error.code !== 'ESRCH') throw error;
					}
					await Promise.race([exited, delay(5000)]);
					if (!childExited) {
						try {
							process.kill(-child.pid, 'SIGKILL');
						} catch (error) {
							if (error.code !== 'ESRCH') throw error;
						}
						await Promise.race([exited, delay(5000)]);
						if (!childExited)
							throw new Error('Wrangler did not exit; ownership inventory retained');
					}
				}
				await writes;
				await rm(info.inventory, { force: true });
				await rm(info.lock, { recursive: true });
			})().then(
				() => finish(),
				(error) => {
					finish(error);
					throw error;
				},
			);
		}
		return stopping;
	};
	const signalStop = () => {
		stop().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	};
	try {
		await save();
		await checkPort(info.port);
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_|DOCKER_)/.test(key),
			),
		);
		Object.assign(env, { WRANGLER_SEND_METRICS: 'false', CI: 'true' });
		child = spawn(
			'mise',
			[
				'exec',
				'npm:pnpm@10.24.0',
				'--',
				'pnpm',
				'--dir',
				info.wranglerDir,
				'exec',
				'wrangler',
				'dev',
				'--persist-to',
				info.persist,
				'--ip',
				'127.0.0.1',
				'--port',
				String(info.port),
			],
			{ cwd: info.wranglerDir, env, stdio: 'inherit', detached: true },
		);
		let childError;
		child.on('error', (error) => {
			childError = error;
			childExited = true;
		});
		child.on('exit', () => {
			childExited = true;
			if (inventory.ready && !stopping) {
				process.exitCode = 1;
				stop().catch((error) => console.error(error));
			}
		});
		inventory.childPid = child.pid;
		await save();
		process.on('SIGINT', signalStop);
		process.on('SIGTERM', signalStop);
		const ready = () => healthy(`http://${info.host}:${info.port}/api/health`);
		const deadline = Date.now() + timeoutMs;
		while (!stopping) {
			if (childExited) throw childError ?? new Error('Wrangler exited before readiness');
			if (await ready()) break;
			if (Date.now() >= deadline) throw new Error('Local readiness timed out (/api/health)');
			await delay(500);
		}
		if (stopping) throw new Error('Startup cancelled');
		inventory.ready = true;
		await save();
		let missedReadiness = 0;
		const tick = async () => {
			try {
				if (childExited) throw new Error('Local runtime lost readiness');
				if (!(await ready())) {
					if (++missedReadiness < 3) {
						if (!stopping) timer = setTimeout(tick, 1000);
						return;
					}
					throw new Error('Local runtime lost readiness');
				}
				missedReadiness = 0;
				if (!stopping) timer = setTimeout(tick, 1000);
			} catch (error) {
				console.error(error);
				process.exitCode = 1;
				await stop().catch((cleanupError) => console.error(cleanupError));
			}
		};
		timer = setTimeout(tick, 1000);
		return { ...info, runId, stop, done };
	} catch (error) {
		// A stale inventory belongs to a prior run and must never be deleted.
		try {
			const existing = JSON.parse(await readFile(info.inventory, 'utf8'));
			if (existing.runId === runId) await stop();
			else await rm(info.lock, { recursive: true });
		} catch (cleanupError) {
			error.message += `; cleanup: ${cleanupError.message}`;
		}
		throw error;
	}
}
