import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createTestUser } from './utils';
import { VirtualAuthenticator } from './webauthn-helper';

// Runs under vitest.webauthn-origins.config.ts, which binds
// WEBAUTHN_ORIGINS=http://localhost:5173 (the vite dev proxy origin).
// Default self-origin is http://localhost; rpID for both is `localhost`.

const BASE = 'http://localhost';
const DEV_ORIGIN = 'http://localhost:5173';

interface OptionsResponse {
	options: { challenge: string };
	ceremonyId: string;
}

async function post(url: string, token: string | null | undefined, body: unknown, origin?: string) {
	return SELF.fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(origin ? { Origin: origin } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe('webauthn origin allowlist variant', () => {
	it('allowlisted dev origin completes register and login ceremonies', async () => {
		const user = await createTestUser({
			email: `webauthn-origins-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Origins User',
		});
		const authenticator = new VirtualAuthenticator();
		await authenticator.init();

		// Register through the dev origin
		const optionsRes = await post(
			`${BASE}/api/auth/webauthn/register/options`,
			user.token,
			{},
			DEV_ORIGIN,
		);
		expect(optionsRes.status).toBe(200);
		const options = (await optionsRes.json()) as OptionsResponse;
		const registration = await authenticator.createRegistrationResponse({
			challenge: options.options.challenge,
			origin: DEV_ORIGIN,
			rpID: 'localhost',
		});
		const verifyRes = await post(
			`${BASE}/api/auth/webauthn/verify/register`,
			user.token,
			{ ceremonyId: options.ceremonyId, name: 'Dev Key', response: registration },
			DEV_ORIGIN,
		);
		expect(verifyRes.status).toBe(200);

		// Usernameless login through the dev origin
		const loginOptionsRes = await post(
			`${BASE}/api/auth/webauthn/login/options`,
			null,
			{},
			DEV_ORIGIN,
		);
		expect(loginOptionsRes.status).toBe(200);
		const loginOptions = (await loginOptionsRes.json()) as OptionsResponse;
		const assertion = await authenticator.createAuthenticationResponse({
			challenge: loginOptions.options.challenge,
			origin: DEV_ORIGIN,
			rpID: 'localhost',
		});
		const loginVerifyRes = await post(
			`${BASE}/api/auth/webauthn/verify/login`,
			null,
			{ ceremonyId: loginOptions.ceremonyId, response: assertion },
			DEV_ORIGIN,
		);
		expect(loginVerifyRes.status).toBe(200);
		const loginData = (await loginVerifyRes.json()) as {
			user: { id: string };
			hasPasskey: boolean;
		};
		expect(loginData.user.id).toBe(user.id);
		expect(loginData.hasPasskey).toBe(true);
	});

	it('options ↔ verify origin mismatch is rejected', async () => {
		const user = await createTestUser({
			email: `webauthn-origins-mismatch-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Mismatch User',
		});
		const authenticator = new VirtualAuthenticator();
		await authenticator.init();

		// Options issued under the allowlisted dev origin…
		const optionsRes = await post(
			`${BASE}/api/auth/webauthn/register/options`,
			user.token,
			{},
			DEV_ORIGIN,
		);
		const options = (await optionsRes.json()) as OptionsResponse;

		// …but verified under the (differently) accepted self origin: the
		// pinned row no longer matches, even though both origins are trusted.
		const registration = await authenticator.createRegistrationResponse({
			challenge: options.options.challenge,
			origin: BASE,
			rpID: 'localhost',
		});
		const verifyRes = await post(
			`${BASE}/api/auth/webauthn/verify/register`,
			user.token,
			{ ceremonyId: options.ceremonyId, name: 'Mismatch', response: registration },
			BASE,
		);
		expect(verifyRes.status).toBe(400);
		expect(((await verifyRes.json()) as { error: string }).error).toBe('ceremony_invalid');
	});

	it('unapproved origins are still rejected in this variant', async () => {
		const response = await post(
			`${BASE}/api/auth/webauthn/login/options`,
			null,
			{},
			'http://evil.example',
		);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: string }).error).toBe('origin_not_allowed');
	});
});
