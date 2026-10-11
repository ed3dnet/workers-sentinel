// Seed demo data against a running local supervisor: one user, one project
// and a few Sentry envelope events shaped like real command-line feedback.
// Usage: node _devenv/cloudflare/demo.mjs [baseUrl]
import { fileURLToPath } from 'node:url';
// Shared virtual authenticator (Node's native TS type-stripping imports it
// without a build step) — the admin surface requires a passkey-minted
// session, so project creation runs a real ceremony.
import { VirtualAuthenticator } from '../../packages/workers-sentinel/test/webauthn-helper.ts';
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

async function api(base, path, { method = 'GET', token, body, headers = {} } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
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
		return { token: login.token, userId: login.user.id };
	} catch {
		const register = await api(base, '/api/auth/register', { method: 'POST', body: DEMO_USER });
		return { token: register.token, userId: register.user.id };
	}
}

/** Mint a passkey session via the real HTTP ceremonies (the admin gate). */
async function getAdminPasskeySession(base, passwordToken) {
	// Ceremonies use the localhost origin: workerd drops an Origin header
	// that equals the socket origin (127.0.0.1:port), and the supervisor
	// binds WEBAUTHN_ORIGINS to this form so the worker accepts it.
	const origin = `http://localhost:${new URL(base).port}`;
	const rpID = 'localhost';
	const ceremonyHeaders = { Origin: origin };
	const authenticator = new VirtualAuthenticator();
	await authenticator.init();

	const options = await api(base, '/api/auth/webauthn/register/options', {
		method: 'POST',
		token: passwordToken,
		body: {},
		headers: ceremonyHeaders,
	});
	const registration = await authenticator.createRegistrationResponse({
		challenge: options.options.challenge,
		origin,
		rpID,
	});
	await api(base, '/api/auth/webauthn/verify/register', {
		method: 'POST',
		token: passwordToken,
		body: { ceremonyId: options.ceremonyId, name: 'Demo Key', response: registration },
		headers: ceremonyHeaders,
	});

	const loginOptions = await api(base, '/api/auth/webauthn/login/options', {
		method: 'POST',
		body: {},
		headers: ceremonyHeaders,
	});
	const assertion = await authenticator.createAuthenticationResponse({
		challenge: loginOptions.options.challenge,
		origin,
		rpID,
		userHandle: null,
	});
	const login = await api(base, '/api/auth/webauthn/verify/login', {
		method: 'POST',
		body: { ceremonyId: loginOptions.ceremonyId, response: assertion },
		headers: ceremonyHeaders,
	});
	return login.token;
}

async function findOrCreateProject(base, token, userId) {
	const listed = await api(base, '/api/projects', { token });
	const projects = Array.isArray(listed) ? listed : (listed.projects ?? []);
	const existing = projects.find((p) => p.name === PROJECT_NAME);
	if (existing) {
		const detail = await api(base, `/api/projects/${existing.slug}`, { token });
		const project = detail.project ?? detail;
		if (project.publicKey) return project;
	}
	// Project creation is admin-only: the demo user is the first user on a
	// fresh local stack (admin), so create with a passkey session and the
	// demo user as the assigned owner.
	const adminToken = await getAdminPasskeySession(base, token);
	const created = await api(base, '/api/admin/projects', {
		method: 'POST',
		token: adminToken,
		body: { name: PROJECT_NAME, platform: 'node', ownerId: userId },
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
const { token, userId } = await loginOrRegister(base);
const project = await findOrCreateProject(base, token, userId);
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
