// Seed demo data against a running local supervisor: one user, one project
// and a few Sentry envelope events shaped like real command-line feedback.
// Usage: node _devenv/cloudflare/demo.mjs [baseUrl]
import { fileURLToPath } from 'node:url';
import { localLayout } from './local.mjs';

const DEMO_USER = {
	email: 'demo@sentinel.local',
	password: 'sentinel-demo-password',
	name: 'Sentinel Demo',
};
const PROJECT_NAME = 'CLI Feedback';

function envelope(projectId, publicKey, payload) {
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const header = {
		event_id: eventId,
		dsn: `https://${publicKey}@localhost/${projectId}`,
		sdk: { name: 'sentinel.demo.cli', version: '1.0.0' },
		sent_at: new Date().toISOString(),
	};
	return {
		eventId,
		body: [
			JSON.stringify(header),
			JSON.stringify({ type: 'event' }),
			JSON.stringify({ event_id: eventId, timestamp: new Date().toISOString(), ...payload }),
		].join('\n'),
	};
}

function cliException() {
	return {
		platform: 'node',
		level: 'error',
		environment: 'development',
		release: 'demo-cli@1.4.2',
		logger: 'cli',
		tags: { cli: 'demo-cli', command: 'publish', host: 'workstation-01' },
		user: { id: 'demo-user', username: 'ed' },
		exception: {
			values: [
				{
					type: 'CLIRuntimeError',
					value: 'connection reset while uploading artifact',
					stacktrace: {
						frames: [
							{ filename: 'publish.ts', function: 'uploadArtifact', lineno: 118, in_app: true },
							{ filename: 'publish.ts', function: 'run', lineno: 42, in_app: true },
							{ filename: 'cli.ts', function: 'main', lineno: 12, in_app: true },
						],
					},
				},
			],
		},
	};
}

function cliMessage() {
	return {
		platform: 'node',
		level: 'warning',
		environment: 'development',
		release: 'demo-cli@1.4.2',
		logger: 'cli',
		message: 'command exited with status 1: demo-cli deploy --env production',
		tags: { cli: 'demo-cli', command: 'deploy' },
		user: { id: 'demo-user', username: 'ed' },
	};
}

async function api(base, path, { method = 'GET', token, body } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return text ? JSON.parse(text) : {};
}

async function loginOrRegister(base) {
	try {
		const login = await api(base, '/api/auth/login', {
			method: 'POST',
			body: { email: DEMO_USER.email, password: DEMO_USER.password },
		});
		return login.token;
	} catch {
		const register = await api(base, '/api/auth/register', { method: 'POST', body: DEMO_USER });
		return register.token;
	}
}

async function findOrCreateProject(base, token) {
	const listed = await api(base, '/api/projects', { token });
	const projects = Array.isArray(listed) ? listed : (listed.projects ?? []);
	const existing = projects.find((p) => p.name === PROJECT_NAME);
	if (existing) {
		const detail = await api(base, `/api/projects/${existing.slug}`, { token });
		const project = detail.project ?? detail;
		if (project.publicKey) return project;
	}
	const created = await api(base, '/api/projects', {
		method: 'POST',
		token,
		body: { name: PROJECT_NAME, platform: 'node' },
	});
	return created.project;
}

async function sendEvent(base, project, payload) {
	const { eventId, body } = envelope(project.id, project.publicKey, payload);
	const response = await fetch(`${base}/api/${project.id}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
		},
		body,
		signal: AbortSignal.timeout(15000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`ingestion failed (${response.status}): ${text}`);
	return eventId;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const layout = await localLayout(root, 'dev');
const base = process.argv[2] ?? `http://${layout.host}:${layout.port}`;
const token = await loginOrRegister(base);
const project = await findOrCreateProject(base, token);
const ids = [];
// Two identical exceptions demonstrate fingerprint grouping into one issue.
ids.push(await sendEvent(base, project, cliException()));
ids.push(await sendEvent(base, project, cliException()));
ids.push(await sendEvent(base, project, cliMessage()));
console.log(`Base:     ${base}`);
console.log(`Login:    ${DEMO_USER.email} / ${DEMO_USER.password}`);
console.log(`Project:  ${project.name} (id ${project.id}, slug ${project.slug})`);
console.log(
	`DSN:      ${project.dsn ?? `https://${project.publicKey}@${layout.host}:${layout.port}/${project.id}`}`,
);
console.log(`Events:   ${ids.join(', ')}`);
console.log(`Dashboard: ${base}/projects/${project.slug}/issues`);
console.log(
	'Note: the two identical CLIRuntimeError events should group into one issue (count 2).',
);
