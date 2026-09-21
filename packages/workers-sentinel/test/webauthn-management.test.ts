import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authFetch, createTestUser } from './utils';
import { type RegistrationResponseJSONLike, VirtualAuthenticator } from './webauthn-helper';

// Credential-deletion coverage runs in its OWN vitest worker (see
// vitest.webauthn-management.config.ts): under vitest-pool-workers'
// singleWorker + isolatedStorage:false, exercising the credential-delete
// flow from the shared main-suite worker triggers a progressive
// isolate-wide transport slowdown in the runner (reproducible; main is
// unaffected, and every configuration without these calls is green).
// Isolating the process keeps every other suite green without losing
// coverage. See AGENTS.md "Passkeys" for the full note.

const BASE = 'http://localhost';
const REGISTER_OPTIONS_URL = `${BASE}/api/auth/webauthn/register/options`;
const REGISTER_VERIFY_URL = `${BASE}/api/auth/webauthn/verify/register`;
const CREDENTIALS_URL = `${BASE}/api/auth/webauthn/credentials`;

async function registerPasskey(token: string, authenticator: VirtualAuthenticator, name: string) {
	const optionsResponse = await authFetch(token, REGISTER_OPTIONS_URL, {
		method: 'POST',
		body: '{}',
	});
	const optionsData = (await optionsResponse.json()) as {
		options: { challenge: string };
		ceremonyId: string;
	};
	const response = await authenticator.createRegistrationResponse({
		challenge: optionsData.options.challenge,
		origin: BASE,
		rpID: 'localhost',
	});
	const verify = await authFetch(token, REGISTER_VERIFY_URL, {
		method: 'POST',
		body: JSON.stringify({
			ceremonyId: optionsData.ceremonyId,
			name,
			response: response as RegistrationResponseJSONLike,
		}),
	});
	const data = (await verify.json()) as {
		credential?: { id: string; name: string };
		error?: string;
	};
	return { verify, data };
}

async function doFetch(url: string, token: string | null, body: unknown) {
	return SELF.fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe('webauthn credential management (isolated worker)', () => {
	let user: Awaited<ReturnType<typeof createTestUser>>;
	let otherUser: Awaited<ReturnType<typeof createTestUser>>;

	beforeAll(async () => {
		user = await createTestUser({
			email: `webauthn-mgmt-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Mgmt User',
		});
		otherUser = await createTestUser({
			email: `webauthn-mgmt-other-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Mgmt Other',
		});
	});

	describe('credential management and hasPasskey lifecycle (AC.5)', () => {
		it('hasPasskey transitions false → true → false across the lifecycle', async () => {
			// Password login response carries the flag
			const loginBefore = await SELF.fetch(`${BASE}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: otherUser.email, password: 'testpassword123' }),
			});
			expect(((await loginBefore.json()) as { hasPasskey: boolean }).hasPasskey).toBe(false);

			// /me reflects it
			const meBefore = await authFetch(otherUser.token!, `${BASE}/api/auth/me`);
			expect(((await meBefore.json()) as { hasPasskey: boolean }).hasPasskey).toBe(false);

			// Register a passkey for the other user
			const otherAuthenticator = new VirtualAuthenticator();
			await otherAuthenticator.init();
			const { verify: registerVerify } = await registerPasskey(
				otherUser.token!,
				otherAuthenticator,
				'Other Key',
			);
			expect(registerVerify.status).toBe(200);

			const loginAfter = await SELF.fetch(`${BASE}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: otherUser.email, password: 'testpassword123' }),
			});
			expect(((await loginAfter.json()) as { hasPasskey: boolean }).hasPasskey).toBe(true);

			const meAfter = await authFetch(otherUser.token!, `${BASE}/api/auth/me`);
			expect(((await meAfter.json()) as { hasPasskey: boolean }).hasPasskey).toBe(true);

			// Deleting the last passkey is allowed and flips it back
			const list = await authFetch(otherUser.token!, CREDENTIALS_URL);
			const listData = (await list.json()) as { credentials: { id: string }[] };
			expect(listData.credentials).toHaveLength(1);
			const del = await authFetch(otherUser.token!, `${CREDENTIALS_URL}/delete`, {
				method: 'POST',
				body: JSON.stringify({ credentialId: listData.credentials[0].id }),
			});
			expect(del.status).toBe(200);

			const meFinal = await authFetch(otherUser.token!, `${BASE}/api/auth/me`);
			expect(((await meFinal.json()) as { hasPasskey: boolean }).hasPasskey).toBe(false);
		});

		it('delete is owner-only (cross-user 404)', async () => {
			// Self-contained: give the user a credential to attempt deleting
			const ownAuthenticator = new VirtualAuthenticator();
			await ownAuthenticator.init();
			const { verify: own } = await registerPasskey(user.token!, ownAuthenticator, 'Own Key');
			expect(own.status).toBe(200);

			const list = await authFetch(user.token!, CREDENTIALS_URL);
			const listData = (await list.json()) as { credentials: { id: string }[] };
			const credentialId = listData.credentials[0].id;

			const crossDelete = await authFetch(otherUser.token!, `${CREDENTIALS_URL}/delete`, {
				method: 'POST',
				body: JSON.stringify({ credentialId }),
			});
			expect(crossDelete.status).toBe(404);

			const unknownDelete = await authFetch(user.token!, `${CREDENTIALS_URL}/delete`, {
				method: 'POST',
				body: JSON.stringify({ credentialId: 'does-not-exist' }),
			});
			expect(unknownDelete.status).toBe(404);
		});
	});

	describe('session-only auth (isolated)', () => {
		it('register/manage endpoints: anonymous 401, wst_ 403, session 200', async () => {
			const anonymous = await doFetch(REGISTER_OPTIONS_URL, null, {});
			expect(anonymous.status).toBe(401);

			const anonymousList = await SELF.fetch(CREDENTIALS_URL);
			expect(anonymousList.status).toBe(401);

			// Mint an API token (session required), then try the passkey surface
			const mint = await authFetch(user.token!, `${BASE}/api/auth/tokens`, {
				method: 'POST',
				body: JSON.stringify({ name: 'passkey-probe' }),
			});
			const mintData = (await mint.json()) as { rawToken: string };
			expect(mintData.rawToken.startsWith('wst_')).toBe(true);

			const wstRegister = await doFetch(REGISTER_OPTIONS_URL, mintData.rawToken, {});
			expect(wstRegister.status).toBe(403);
			expect(((await wstRegister.json()) as { error: string }).error).toBe('session_required');

			const wstVerify = await doFetch(REGISTER_VERIFY_URL, mintData.rawToken, {
				ceremonyId: 'x',
				name: 'x',
				response: {},
			});
			expect(wstVerify.status).toBe(403);

			const wstList = await SELF.fetch(CREDENTIALS_URL, {
				headers: { Authorization: `Bearer ${mintData.rawToken}` },
			});
			expect(wstList.status).toBe(403);
			expect(((await wstList.json()) as { error: string }).error).toBe('session_required');

			const wstDelete = await SELF.fetch(`${CREDENTIALS_URL}/delete`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${mintData.rawToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ credentialId: 'some-id' }),
			});
			expect(wstDelete.status).toBe(403);

			const sessionList = await authFetch(user.token!, CREDENTIALS_URL);
			expect(sessionList.status).toBe(200);
		});
	});
});
