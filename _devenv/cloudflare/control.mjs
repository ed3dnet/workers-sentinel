// Authenticated loopback-only stop endpoint, ported from the
// ed3dsite-2025 _devenv/cloudflare pattern. `down` never signals a recorded
// PID: it POSTs to this endpoint with a random 256-bit bearer; the record is
// removed only after a clean close.

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export async function serveControl(running, record) {
	const token = randomBytes(32).toString('hex');
	const server = createServer(async (req, res) => {
		if (
			req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
			req.method !== 'POST' ||
			req.url !== '/stop' ||
			req.headers.authorization !== `Bearer ${token}`
		) {
			res.writeHead(403).end();
			return;
		}
		try {
			await running.stop();
			res.end('Stopped');
		} catch {
			res.writeHead(500).end('Cleanup failed; inventory and lock retained');
		} finally {
			await close();
		}
	});
	let closing;
	const close = () => {
		if (!closing) {
			closing = (async () => {
				server.close();
				server.closeIdleConnections();
				await rm(record, { force: true });
			})();
		}
		return closing;
	};
	try {
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const port = server.address().port;
		await writeFile(record, JSON.stringify({ port, token }), { flag: 'wx', mode: 0o600 });
		running.done.then(
			() => close(),
			(error) => {
				console.error(error);
				process.exitCode = 1;
			},
		);
		return { port, token, close };
	} catch (error) {
		try {
			await close();
		} catch (cleanup) {
			error.message += `; control cleanup: ${cleanup.message}`;
		}
		try {
			await running.stop();
		} catch (cleanup) {
			error.message += `; cleanup: ${cleanup.message}`;
		}
		throw error;
	}
}
