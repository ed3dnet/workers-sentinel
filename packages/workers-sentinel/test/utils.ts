import { env, SELF } from 'cloudflare:test';
import { VirtualAuthenticator } from './webauthn-helper';

export interface TestUser {
	email: string;
	password: string;
	name: string;
	token?: string;
}

export interface TestProject {
	id: string;
	name: string;
	slug: string;
	publicKey: string;
	dsn: string;
}

export interface AdminPasskeySession {
	userId: string;
	token: string;
}

const BASE = 'http://localhost';

// ---------------------------------------------------------------------------
// Deterministic admin fixture
// ---------------------------------------------------------------------------

const ADMIN_FIXTURE_EMAIL = 'admin-fixture@example.com';
const ADMIN_FIXTURE_PASSWORD = 'admin-fixture-password-123';

/**
 * Module state may or may not survive across test files under
 * `isolate: false`; the bootstrap is idempotent either way (register →
 * login on `user_exists`), so a per-file re-bootstrap costs one ceremony.
 */
let adminFixturePromise: Promise<AdminPasskeySession> | null = null;
let fixtureAuthenticator: VirtualAuthenticator | null = null;

const AUTH_STATE = () => env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));

/**
 * The deterministic admin passkey session shared by the whole suite:
 *
 *  1. register the fixture user (login instead when it already exists),
 *  2. promote it to admin via a direct AuthState DO call to the real
 *     `/admin/update-user` handler with a claimed `requestingUserRole` —
 *     the internal surface is service-binding-only by design and its
 *     handlers trust the claimed role (the same direct-DO fixture pattern
 *     webauthn.test.ts uses),
 *  3. register a passkey via the real HTTP ceremony,
 *  4. sign in with the passkey — a 'passkey'-method session that passes
 *     the admin gate.
 *
 * Cached for the run (one ceremony per module instance, not per test).
 */
export async function getAdminPasskeySession(): Promise<AdminPasskeySession> {
	adminFixturePromise ??= bootstrapAdminPasskeySession();
	return adminFixturePromise;
}

/**
 * Run a real passkey registration ceremony over HTTP for `sessionToken`
 * using the given authenticator. Returns the verify response.
 */
export async function registerPasskeyCeremony(
	sessionToken: string,
	authenticator: VirtualAuthenticator,
	name = 'Test Passkey',
): Promise<Response> {
	const optionsResponse = await SELF.fetch(`${BASE}/api/auth/webauthn/register/options`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
		body: '{}',
	});
	const optionsData = (await optionsResponse.json()) as {
		options?: { challenge: string };
		ceremonyId?: string;
	};
	if (!optionsResponse.ok || !optionsData.options?.challenge || !optionsData.ceremonyId) {
		throw new Error(`Passkey register options failed: ${JSON.stringify(optionsData)}`);
	}
	const registration = await authenticator.createRegistrationResponse({
		challenge: optionsData.options.challenge,
		origin: BASE,
		rpID: 'localhost',
	});
	return SELF.fetch(`${BASE}/api/auth/webauthn/verify/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
		body: JSON.stringify({
			ceremonyId: optionsData.ceremonyId,
			name,
			response: registration,
		}),
	});
}

/**
 * Run a real (usernameless) passkey login ceremony over HTTP. Returns the
 * verify response and parsed body.
 */
export async function passkeyLoginCeremony(authenticator: VirtualAuthenticator): Promise<{
	verify: Response;
	data: { user?: { id: string }; token?: string; authMethod?: string; error?: string };
}> {
	const optionsResponse = await SELF.fetch(`${BASE}/api/auth/webauthn/login/options`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}',
	});
	const optionsData = (await optionsResponse.json()) as {
		options?: { challenge: string };
		ceremonyId?: string;
	};
	if (!optionsResponse.ok || !optionsData.options?.challenge || !optionsData.ceremonyId) {
		throw new Error(`Passkey login options failed: ${JSON.stringify(optionsData)}`);
	}
	const assertion = await authenticator.createAuthenticationResponse({
		challenge: optionsData.options.challenge,
		origin: BASE,
		rpID: 'localhost',
		userHandle: null,
	});
	const verify = await SELF.fetch(`${BASE}/api/auth/webauthn/verify/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ceremonyId: optionsData.ceremonyId, response: assertion }),
	});
	return {
		verify,
		data: (await verify.json()) as {
			user?: { id: string };
			token?: string;
			authMethod?: string;
			error?: string;
		},
	};
}

/**
 * A password-method session for the (admin) fixture user — the strict-gate
 * counterpart of the passkey session in gate tests.
 */
export async function getAdminPasswordSession(): Promise<string> {
	// Ensure the fixture exists and is promoted before logging in
	await getAdminPasskeySession();
	const response = await SELF.fetch(`${BASE}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: ADMIN_FIXTURE_EMAIL,
			password: ADMIN_FIXTURE_PASSWORD,
		}),
	});
	if (!response.ok) {
		throw new Error(`Admin fixture password login failed: ${await response.text()}`);
	}
	const data = (await response.json()) as { token: string };
	return data.token;
}

async function bootstrapAdminPasskeySession(): Promise<AdminPasskeySession> {
	// 1. Register (or sign in when the fixture user already exists)
	let userId: string | undefined;
	let sessionToken: string | undefined;
	const registerResponse = await SELF.fetch(`${BASE}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: ADMIN_FIXTURE_EMAIL,
			password: ADMIN_FIXTURE_PASSWORD,
			name: 'Admin Fixture',
			setupToken: 'test-setup-token',
		}),
	});
	const registerData = (await registerResponse.json()) as {
		user?: { id: string };
		token?: string;
		error?: string;
	};
	if (registerResponse.ok && registerData.user && registerData.token) {
		userId = registerData.user.id;
		sessionToken = registerData.token;
	} else if (registerData.error === 'user_exists') {
		const loginResponse = await SELF.fetch(`${BASE}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: ADMIN_FIXTURE_EMAIL, password: ADMIN_FIXTURE_PASSWORD }),
		});
		const loginData = (await loginResponse.json()) as {
			user?: { id: string };
			token?: string;
		};
		if (!loginResponse.ok || !loginData.user || !loginData.token) {
			throw new Error(`Admin fixture login failed: ${JSON.stringify(loginData)}`);
		}
		userId = loginData.user.id;
		sessionToken = loginData.token;
	} else {
		throw new Error(`Admin fixture registration failed: ${JSON.stringify(registerData)}`);
	}

	// 2. Promote to admin via the real internal handler (claimed role; the
	//    internal surface is the documented service-binding trust boundary).
	//    Idempotent: promoting an existing admin is a no-op.
	const promoteResponse = await AUTH_STATE().fetch('http://internal/admin/update-user', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			requestingUserId: userId,
			requestingUserRole: 'admin',
			userId,
			role: 'admin',
		}),
	});
	if (!promoteResponse.ok) {
		throw new Error(`Admin fixture promotion failed: ${await promoteResponse.text()}`);
	}

	// 3. Register a passkey via the real HTTP ceremony
	const authenticator = new VirtualAuthenticator();
	await authenticator.init();
	const verifyResponse = await registerPasskeyCeremony(
		sessionToken,
		authenticator,
		'Admin Fixture Key',
	);
	if (!verifyResponse.ok) {
		throw new Error(`Admin fixture passkey registration failed: ${await verifyResponse.text()}`);
	}
	fixtureAuthenticator = authenticator;

	// 4. Sign in with the passkey (a 'passkey'-method session)
	const login = await passkeyLoginCeremony(fixtureAuthenticator);
	if (!login.verify.ok || !login.data.user || !login.data.token) {
		throw new Error(`Admin fixture passkey login failed: ${JSON.stringify(login.data)}`);
	}
	return { userId: login.data.user.id, token: login.data.token };
}

/**
 * Create a test project. Project creation is admin-only now, so this goes
 * through `POST /api/admin/projects` with the shared admin passkey session,
 * assigning the caller of `token` as the owner (call sites are unchanged —
 * they pass the intended owner's token).
 */
export async function createTestProject(
	token: string,
	project: { name: string; platform?: string } = {
		name: `Test Project ${Date.now()}`,
		platform: 'javascript',
	},
): Promise<TestProject> {
	// Resolve the owner id for the given token
	const meResponse = await SELF.fetch(`${BASE}/api/auth/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!meResponse.ok) {
		throw new Error(`createTestProject: owner /me failed (${meResponse.status})`);
	}
	const me = (await meResponse.json()) as { user: { id: string } };

	const adminSession = await getAdminPasskeySession();
	const response = await SELF.fetch(`${BASE}/api/admin/projects`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${adminSession.token}`,
		},
		body: JSON.stringify({
			name: project.name,
			platform: project.platform,
			ownerId: me.user.id,
		}),
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(`Failed to create project: ${JSON.stringify(error)}`);
	}

	const data = (await response.json()) as { project: TestProject; dsn: string };
	return {
		...data.project,
		dsn: data.dsn,
	};
}

/**
 * Make an authenticated admin request with the shared passkey session.
 * (Gate-matrix tests that need other credential types use SELF.fetch
 * directly so they control the exact Authorization header.)
 */
export async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const session = await getAdminPasskeySession();
	return SELF.fetch(path, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${session.token}`,
			...(options.headers || {}),
		},
	});
}

/**
 * Create a test user and return the user data with token
 */
export async function createTestUser(
	user: Omit<TestUser, 'token'> = {
		email: `test-${Date.now()}@example.com`,
		password: 'testpassword123',
		name: 'Test User',
	},
	retries = 3,
): Promise<TestUser & { id: string }> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const response = await SELF.fetch('http://localhost/api/auth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...user, setupToken: 'test-setup-token' }),
			});

			if (!response.ok) {
				const text = await response.text();
				// Check if this is a DO reset error - retry if so
				if (text.includes('invalidating this Durable Object') && attempt < retries - 1) {
					await new Promise((r) => setTimeout(r, 100));
					continue;
				}
				try {
					const error = JSON.parse(text);
					throw new Error(`Failed to create user: ${JSON.stringify(error)}`);
				} catch {
					throw new Error(`Failed to create user: ${text}`);
				}
			}

			const data = (await response.json()) as { user: { id: string }; token: string };
			return {
				...user,
				id: data.user.id,
				token: data.token,
			};
		} catch (e) {
			lastError = e as Error;
			if (attempt < retries - 1) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}

	throw lastError || new Error('Failed to create user after retries');
}

/**
 * Login as an existing user
 */
export async function loginUser(email: string, password: string): Promise<string> {
	const response = await SELF.fetch('http://localhost/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(`Failed to login: ${JSON.stringify(error)}`);
	}

	const data = (await response.json()) as { token: string };
	return data.token;
}

/**
 * Create a Sentry envelope for testing ingestion
 */
export function createTestEnvelope(
	projectId: string,
	publicKey: string,
	event: {
		message?: string;
		level?: string;
		exception?: {
			type: string;
			value: string;
			stacktrace?: {
				frames: Array<{
					filename: string;
					function: string;
					lineno: number;
					in_app?: boolean;
				}>;
			};
		};
		tags?: Record<string, string>;
		user?: { id?: string; email?: string };
		environment?: string;
		release?: string;
	} = {},
): string {
	const eventId = crypto.randomUUID().replace(/-/g, '');
	const timestamp = new Date().toISOString();

	const envelopeHeader = {
		event_id: eventId,
		dsn: `https://${publicKey}@localhost/${projectId}`,
		sdk: { name: 'sentry.javascript.browser', version: '7.0.0' },
		sent_at: timestamp,
	};

	const itemHeader = {
		type: 'event',
	};

	const eventPayload: Record<string, unknown> = {
		event_id: eventId,
		timestamp,
		platform: 'javascript',
		level: event.level || 'error',
		...event,
	};

	if (event.exception) {
		eventPayload.exception = {
			values: [
				{
					type: event.exception.type,
					value: event.exception.value,
					stacktrace: event.exception.stacktrace || {
						frames: [
							{
								filename: 'app.js',
								function: 'handleError',
								lineno: 42,
								in_app: true,
							},
						],
					},
				},
			],
		};
	} else if (event.message) {
		eventPayload.message = event.message;
	} else {
		// Default error
		eventPayload.exception = {
			values: [
				{
					type: 'Error',
					value: 'Test error message',
					stacktrace: {
						frames: [
							{
								filename: 'test.js',
								function: 'testFunction',
								lineno: 10,
								in_app: true,
							},
						],
					},
				},
			],
		};
	}

	return [
		JSON.stringify(envelopeHeader),
		JSON.stringify(itemHeader),
		JSON.stringify(eventPayload),
	].join('\n');
}

/**
 * Send an event to the ingestion endpoint
 */
export async function sendTestEvent(
	projectId: string,
	publicKey: string,
	event?: Parameters<typeof createTestEnvelope>[2],
): Promise<{ id: string }> {
	const envelope = createTestEnvelope(projectId, publicKey, event);

	const response = await SELF.fetch(`http://localhost/api/${projectId}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
		},
		body: envelope,
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(`Failed to send event: ${JSON.stringify(error)}`);
	}

	return response.json() as Promise<{ id: string }>;
}

/**
 * Make an authenticated request
 */
export async function authFetch(
	token: string,
	url: string,
	options: RequestInit = {},
): Promise<Response> {
	return SELF.fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...(options.headers || {}),
		},
	});
}

/**
 * Wait for a condition to be true (useful for async operations)
 */
export async function waitFor(
	condition: () => Promise<boolean>,
	timeout = 5000,
	interval = 100,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	throw new Error('Timeout waiting for condition');
}
