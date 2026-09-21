import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authFetch, createTestUser } from './utils';
import {
	type AuthenticationResponseJSONLike,
	base64urlToBytes,
	bytesToBase64url,
	type RegistrationResponseJSONLike,
	VirtualAuthenticator,
} from './webauthn-helper';

const BASE = 'http://localhost';
const REGISTER_OPTIONS_URL = `${BASE}/api/auth/webauthn/register/options`;
const REGISTER_VERIFY_URL = `${BASE}/api/auth/webauthn/verify/register`;
const LOGIN_OPTIONS_URL = `${BASE}/api/auth/webauthn/login/options`;
const LOGIN_VERIFY_URL = `${BASE}/api/auth/webauthn/verify/login`;
const CREDENTIALS_URL = `${BASE}/api/auth/webauthn/credentials`;

interface OptionsResponse {
	options: { challenge: string; rp?: { id: string }; allowCredentials?: { id: string }[] };
	ceremonyId: string;
}

const AUTH_STATE = () => env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));

async function doFetch(url: string, token: string | null, body: unknown, origin?: string) {
	return SELF.fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(origin ? { Origin: origin } : {}),
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

async function getRegisterOptions(token: string, origin?: string) {
	const response = await doFetch(REGISTER_OPTIONS_URL, token, {}, origin);
	return { response, data: (await response.json()) as OptionsResponse };
}

async function registerPasskey(
	token: string,
	authenticator: VirtualAuthenticator,
	name = 'Test Key',
	ceremonyContext?: { origin?: string; rpID?: string },
): Promise<{
	verify: Response;
	data: { credential?: { id: string; name: string }; error?: string };
}> {
	const { data: optionsData } = await getRegisterOptions(token, ceremonyContext?.origin);
	const response = await authenticator.createRegistrationResponse({
		challenge: optionsData.options.challenge,
		origin: ceremonyContext?.origin ?? BASE,
		rpID: ceremonyContext?.rpID ?? 'localhost',
	});
	const verify = await doFetch(
		REGISTER_VERIFY_URL,
		token,
		{
			ceremonyId: optionsData.ceremonyId,
			name,
			response,
		},
		ceremonyContext?.origin,
	);
	return { verify, data: (await verify.json()) as { credential?: { id: string; name: string } } };
}

async function loginWithPasskey(
	authenticator: VirtualAuthenticator,
	email?: string,
	ceremonyContext?: { origin?: string; rpID?: string },
): Promise<{
	options: OptionsResponse;
	verify: Response;
	data: { user?: { id: string }; token?: string; error?: string };
}> {
	const optionsResponse = await doFetch(
		LOGIN_OPTIONS_URL,
		null,
		email ? { email } : {},
		ceremonyContext?.origin,
	);
	const options = (await optionsResponse.json()) as OptionsResponse;
	const response = await authenticator.createAuthenticationResponse({
		challenge: options.options.challenge,
		origin: ceremonyContext?.origin ?? BASE,
		rpID: ceremonyContext?.rpID ?? 'localhost',
		userHandle: null,
	});
	const verify = await doFetch(
		LOGIN_VERIFY_URL,
		null,
		{
			ceremonyId: options.ceremonyId,
			response,
		},
		ceremonyContext?.origin,
	);
	return {
		options,
		verify,
		data: (await verify.json()) as { user?: { id: string }; token?: string },
	};
}

async function backdateCeremony(ceremonyId: string, ageMs: number): Promise<void> {
	await AUTH_STATE().fetch('http://internal/webauthn/test/backdate-ceremony', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ceremonyId, ageMs }),
	});
}

async function challengeCount(): Promise<number> {
	const response = await AUTH_STATE().fetch('http://internal/webauthn/test/challenge-count', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}',
	});
	const data = (await response.json()) as { count: number };
	return data.count;
}

async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
	await AUTH_STATE().fetch('http://internal/admin/set-user-disabled', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ requestingUserRole: 'admin', userId, disabled }),
	});
}

describe('webauthn', () => {
	let user: Awaited<ReturnType<typeof createTestUser>>;
	let otherUser: Awaited<ReturnType<typeof createTestUser>>;
	let authenticator: VirtualAuthenticator;

	beforeAll(async () => {
		user = await createTestUser({
			email: `webauthn-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'WebAuthn User',
		});
		otherUser = await createTestUser({
			email: `webauthn-other-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Other User',
		});
		authenticator = new VirtualAuthenticator();
		await authenticator.init();
	});

	describe('registration (AC.1)', () => {
		it('webauthn register stores a named credential', async () => {
			const { verify, data } = await registerPasskey(user.token!, authenticator, 'YubiKey 5C');
			expect(verify.status).toBe(200);
			expect(data.credential?.name).toBe('YubiKey 5C');
			expect(data.credential?.id).toBe(authenticator.credentialIdBase64url);

			const list = await authFetch(user.token!, CREDENTIALS_URL);
			const listData = (await list.json()) as {
				credentials: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
			};
			expect(list.status).toBe(200);
			expect(listData.credentials).toHaveLength(1);
			expect(listData.credentials[0].name).toBe('YubiKey 5C');
			expect(listData.credentials[0].createdAt).toBeTruthy();
			expect(listData.credentials[0].lastUsedAt).toBeNull();
		});

		it('excludeCredentials lists the existing credential on later registrations', async () => {
			const { data } = await getRegisterOptions(user.token!);
			const narrow = data.options as { excludeCredentials?: { id: string }[] };
			expect(narrow.excludeCredentials?.[0]?.id).toBe(authenticator.credentialIdBase64url);
		});

		it('blank and oversized names rejected', async () => {
			const { verify: blank, data: blankData } = await registerPasskey(
				user.token!,
				authenticator,
				'   ',
			);
			expect(blank.status).toBe(400);
			expect(blankData.error).toBe('name_required');

			const { verify: long, data: longData } = await registerPasskey(
				user.token!,
				authenticator,
				'a'.repeat(101),
			);
			expect(long.status).toBe(400);
			expect(longData.error).toBe('invalid_name');

			// A distinct authenticator can register with a 99-char name
			const longOk = new VirtualAuthenticator();
			await longOk.init();
			const { verify: ok } = await registerPasskey(user.token!, longOk, 'b'.repeat(99));
			expect(ok.status).toBe(200);
		});

		it('duplicate credential id yields 409', async () => {
			const { verify, data } = await registerPasskey(user.token!, authenticator, 'Dup');
			expect(verify.status).toBe(409);
			expect(data.error).toBe('credential_exists');
		});
	});

	describe('ceremony lifecycle (AC.3)', () => {
		it('ceremonies are single use and expire', async () => {
			// A malformed attempt consumes the ceremony, and reuse fails closed
			const { data: optionsData } = await getRegisterOptions(user.token!);
			const malformed: RegistrationResponseJSONLike = {
				id: authenticator.credentialIdBase64url,
				rawId: authenticator.credentialIdBase64url,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: bytesToBase64url(new TextEncoder().encode('not-json')),
					attestationObject: '',
					transports: ['usb'],
				},
			};
			const malformedVerify = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: optionsData.ceremonyId,
				name: 'Whatever',
				response: malformed,
			});
			expect(malformedVerify.status).toBe(400);
			expect(((await malformedVerify.json()) as { error: string }).error).toBe(
				'verification_failed',
			);

			// Replaying the ceremony id — even with a now-valid response — fails
			const response = await authenticator.createRegistrationResponse({
				challenge: optionsData.options.challenge,
				origin: BASE,
				rpID: 'localhost',
			});
			const replay = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: optionsData.ceremonyId,
				name: 'Replay',
				response,
			});
			expect(replay.status).toBe(400);
			expect(((await replay.json()) as { error: string }).error).toBe('ceremony_invalid');

			// Backdated (expired) ceremonies never claim
			const { data: freshOptions } = await getRegisterOptions(user.token!);
			await backdateCeremony(freshOptions.ceremonyId, 6 * 60 * 1000);
			const expiredResponse = await authenticator.createRegistrationResponse({
				challenge: freshOptions.options.challenge,
				origin: BASE,
				rpID: 'localhost',
			});
			const expiredVerify = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: freshOptions.ceremonyId,
				name: 'Expired',
				response: expiredResponse,
			});
			expect(expiredVerify.status).toBe(400);
			expect(((await expiredVerify.json()) as { error: string }).error).toBe('ceremony_invalid');

			// Wrong kind: a fresh register ceremony cannot be used to log in,
			// and (per the claim-matching contract) the failed login claim
			// does not consume it — it stays usable for registration
			const { data: kindOptions } = await getRegisterOptions(user.token!);
			const loginVerify = await doFetch(LOGIN_VERIFY_URL, null, {
				ceremonyId: kindOptions.ceremonyId,
				response: await authenticator.createAuthenticationResponse({
					challenge: kindOptions.options.challenge,
					origin: BASE,
					rpID: 'localhost',
				}),
			});
			expect(loginVerify.status).toBe(400);
			expect(((await loginVerify.json()) as { error: string }).error).toBe('ceremony_invalid');
			const survivorAuthenticator = new VirtualAuthenticator();
			await survivorAuthenticator.init();
			const stillWorks = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: kindOptions.ceremonyId,
				name: 'Survivor',
				response: await survivorAuthenticator.createRegistrationResponse({
					challenge: kindOptions.options.challenge,
					origin: BASE,
					rpID: 'localhost',
				}),
			});
			expect(stillWorks.status).toBe(200);

			// Wrong user: another user's ceremony cannot be claimed
			const { data: otherOptions } = await getRegisterOptions(otherUser.token!);
			const crossResponse = await authenticator.createRegistrationResponse({
				challenge: otherOptions.options.challenge,
				origin: BASE,
				rpID: 'localhost',
			});
			const crossVerify = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: otherOptions.ceremonyId,
				name: 'Stolen ceremony',
				response: crossResponse,
			});
			expect(crossVerify.status).toBe(400);
			expect(((await crossVerify.json()) as { error: string }).error).toBe('ceremony_invalid');
		});

		it('valid ceremonyId with a blank name still consumes the ceremony', async () => {
			const { data: optionsData } = await getRegisterOptions(user.token!);
			const blank = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: optionsData.ceremonyId,
				name: '   ',
				response: await authenticator.createRegistrationResponse({
					challenge: optionsData.options.challenge,
					origin: BASE,
					rpID: 'localhost',
				}),
			});
			expect(blank.status).toBe(400);
			expect(((await blank.json()) as { error: string }).error).toBe('name_required');

			const retry = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: optionsData.ceremonyId,
				name: 'Now valid',
				response: await authenticator.createRegistrationResponse({
					challenge: optionsData.options.challenge,
					origin: BASE,
					rpID: 'localhost',
				}),
			});
			expect(retry.status).toBe(400);
			expect(((await retry.json()) as { error: string }).error).toBe('ceremony_invalid');
		});
	});

	describe('login (AC.2, AC.4)', () => {
		it('usernameless passkey login issues a session', async () => {
			const { verify, data } = await loginWithPasskey(authenticator);
			expect(verify.status).toBe(200);
			expect(data.user?.id).toBe(user.id);
			expect(typeof data.token).toBe('string');

			// The fresh session works on /me and reports hasPasskey
			const me = await SELF.fetch(`${BASE}/api/auth/me`, {
				headers: { Authorization: `Bearer ${data.token}` },
			});
			expect(me.status).toBe(200);
			const meData = (await me.json()) as { user: { id: string }; hasPasskey: boolean };
			expect(meData.user.id).toBe(user.id);
			expect(meData.hasPasskey).toBe(true);

			// last_used_at is now set on the credential that was used
			const list = await authFetch(user.token!, CREDENTIALS_URL);
			const listData = (await list.json()) as {
				credentials: { id: string; lastUsedAt: string | null }[];
			};
			const used = listData.credentials.find(
				(credential) => credential.id === authenticator.credentialIdBase64url,
			);
			expect(used?.lastUsedAt).not.toBeNull();
		});

		it('tracks the signature counter: stale counters are rejected', async () => {
			// A replayed signCount (no increment) must fail once the stored counter is > 0
			const staleCounter = authenticator.counter;
			const { verify } = await loginWithPasskey(authenticator);
			expect(verify.status).toBe(200);

			authenticator.counter = staleCounter; // forge a no-increment assertion
			const { verify: stale, data: staleData } = await loginWithPasskey(authenticator);
			expect(stale.status).toBe(401);
			expect(staleData.error).toBe('invalid_credentials');
		});

		it('allows the 0/0 synced-passkey counter case', async () => {
			// A passkey that reports no counter (synced passkeys): stored 0,
			// asserted 0 — lenient by design; any non-zero side must increase
			const syncedAuthenticator = new VirtualAuthenticator();
			await syncedAuthenticator.init();
			const { verify: registerVerify } = await registerPasskey(
				user.token!,
				syncedAuthenticator,
				'Synced Key',
			);
			expect(registerVerify.status).toBe(200);

			syncedAuthenticator.counter = -1; // next response signs counter 0
			const { verify } = await loginWithPasskey(syncedAuthenticator);
			expect(verify.status).toBe(200);
		});

		it('login with email hint binds the challenge without echoing credentials', async () => {
			// The public options response must be shape-identical for hinted
			// and unhinted logins — no credential IDs leak to anonymous callers
			const { options, verify } = await loginWithPasskey(authenticator, user.email);
			expect(options.options.allowCredentials).toBeUndefined();
			expect(verify.status).toBe(200);

			const unbound = await doFetch(LOGIN_OPTIONS_URL, null, {});
			const unboundOptions = (await unbound.json()) as OptionsResponse;
			expect(unboundOptions.options.allowCredentials).toBeUndefined();
			expect(Object.keys(unboundOptions.options)).toEqual(Object.keys(options.options));
		});

		it('user-bound challenge rejects another user’s credential', async () => {
			const { verify, data } = await loginWithPasskey(authenticator, otherUser.email);
			expect(verify.status).toBe(401);
			expect(data.error).toBe('invalid_credentials');
		});

		it('unknown credential id fails uniformly and consumes the ceremony', async () => {
			const stranger = new VirtualAuthenticator();
			await stranger.init();
			const optionsResponse = await doFetch(LOGIN_OPTIONS_URL, null, {});
			const options = (await optionsResponse.json()) as OptionsResponse;
			const response = await stranger.createAuthenticationResponse({
				challenge: options.options.challenge,
				origin: BASE,
				rpID: 'localhost',
			});
			const verify = await doFetch(LOGIN_VERIFY_URL, null, {
				ceremonyId: options.ceremonyId,
				response,
			});
			expect(verify.status).toBe(401);
			expect(((await verify.json()) as { error: string }).error).toBe('invalid_credentials');

			// The ceremony is gone: replay with the real credential also fails
			const replay = await doFetch(LOGIN_VERIFY_URL, null, {
				ceremonyId: options.ceremonyId,
				response: await authenticator.createAuthenticationResponse({
					challenge: options.options.challenge,
					origin: BASE,
					rpID: 'localhost',
				}),
			});
			expect(replay.status).toBe(400);
			expect(((await replay.json()) as { error: string }).error).toBe('ceremony_invalid');
		});

		it('tampered signatures and wrong rpIDs are rejected', async () => {
			// Tampered signature: flip a byte in the DER
			const optionsResponse = await doFetch(LOGIN_OPTIONS_URL, null, {});
			const options = (await optionsResponse.json()) as OptionsResponse;
			const response = await authenticator.createAuthenticationResponse({
				challenge: options.options.challenge,
				origin: BASE,
				rpID: 'localhost',
			});
			const sigBytes = base64urlToBytes(response.response.signature);
			sigBytes[sigBytes.length - 1] ^= 0xff;
			const tampered: AuthenticationResponseJSONLike = {
				...response,
				response: { ...response.response, signature: bytesToBase64url(sigBytes) },
			};
			const tamperedVerify = await doFetch(LOGIN_VERIFY_URL, null, {
				ceremonyId: options.ceremonyId,
				response: tampered,
			});
			expect(tamperedVerify.status).toBe(401);

			// Wrong rpID: authenticator signs a different RP hash than accepted
			const wrongRpOptionsResponse = await doFetch(LOGIN_OPTIONS_URL, null, {});
			const wrongRpOptions = (await wrongRpOptionsResponse.json()) as OptionsResponse;
			const wrongRpResponse = await authenticator.createAuthenticationResponse({
				challenge: wrongRpOptions.options.challenge,
				origin: BASE,
				rpID: 'evil.example',
			});
			const wrongRpVerify = await doFetch(LOGIN_VERIFY_URL, null, {
				ceremonyId: wrongRpOptions.ceremonyId,
				response: wrongRpResponse,
			});
			expect(wrongRpVerify.status).toBe(401);
		});

		it('disabled users get the uniform 401', async () => {
			// A dedicated victim: the first user of a solo file run is admin,
			// and admins cannot be disabled by this endpoint
			const victim = await createTestUser({
				email: `webauthn-victim-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Victim User',
			});
			const victimAuthenticator = new VirtualAuthenticator();
			await victimAuthenticator.init();
			const { verify: registerVerify } = await registerPasskey(
				victim.token!,
				victimAuthenticator,
				'Victim Key',
			);
			expect(registerVerify.status).toBe(200);

			await setUserDisabled(victim.id, true);
			const { verify, data } = await loginWithPasskey(victimAuthenticator);
			expect(verify.status).toBe(401);
			expect(data.error).toBe('invalid_credentials');
			await setUserDisabled(victim.id, false);
		});

		it('origin policy and login verification fail closed', async () => {
			// An unapproved Origin is rejected at the route — even when the
			// authenticator's clientDataJSON matches it exactly
			const evil = 'http://evil.example';
			const evilOptions = await doFetch(LOGIN_OPTIONS_URL, null, {}, evil);
			expect(evilOptions.status).toBe(403);
			expect(((await evilOptions.json()) as { error: string }).error).toBe('origin_not_allowed');

			const evilRegister = await doFetch(REGISTER_OPTIONS_URL, user.token!, {}, evil);
			expect(evilRegister.status).toBe(403);

			const evilVerify = await doFetch(LOGIN_VERIFY_URL, null, { ceremonyId: 'x' }, evil);
			expect(evilVerify.status).toBe(403);

			// Same-origin Origin header (matching the request URL) is accepted
			const sameOriginOptions = await doFetch(LOGIN_OPTIONS_URL, null, {}, BASE);
			expect(sameOriginOptions.status).toBe(200);

			// OPTIONS preflight still answers with the bare 204
			const preflight = await SELF.fetch(LOGIN_OPTIONS_URL, { method: 'OPTIONS' });
			expect(preflight.status).toBe(204);
		});
	});

	describe('session-only auth and bounded challenge issuance (AC.6)', () => {
		it('expired challenges are swept by the next issuance', async () => {
			const { data: optionsData } = await getRegisterOptions(user.token!);
			await backdateCeremony(optionsData.ceremonyId, 6 * 60 * 1000);

			const before = await challengeCount();
			const { response: next } = await getRegisterOptions(user.token!);
			expect(next.status).toBe(200);
			const after = await challengeCount();
			// The new ceremony replaced the swept one: count unchanged
			expect(after).toBe(before);
		});

		it('outstanding-challenge caps bound table growth (oldest evicted)', async () => {
			// Make ceremony #1 strictly oldest so eviction is deterministic
			const { data: first } = await getRegisterOptions(user.token!);
			await backdateCeremony(first.ceremonyId, 60 * 1000);

			for (let i = 0; i < 11; i++) {
				const { response } = await getRegisterOptions(user.token!);
				expect(response.status).toBe(200);
			}

			// Bucket cap is 10: the oldest (first) ceremony was evicted
			const evicted = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: first.ceremonyId,
				name: 'Evicted',
				response: {},
			});
			expect(evicted.status).toBe(400);
			expect(((await evicted.json()) as { error: string }).error).toBe('ceremony_invalid');
		});

		it('public bodies are capped at 8 KiB and must be JSON objects', async () => {
			const bigBody = JSON.stringify({ email: 'a'.repeat(9 * 1024) });
			const big = await SELF.fetch(LOGIN_OPTIONS_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: bigBody,
			});
			expect(big.status).toBe(413);

			const bigVerify = await SELF.fetch(LOGIN_VERIFY_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ceremonyId: 'x', response: { id: 'y'.repeat(9 * 1024) } }),
			});
			expect(bigVerify.status).toBe(413);

			const malformed = await SELF.fetch(LOGIN_OPTIONS_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'not-json',
			});
			expect(malformed.status).toBe(400);

			// null / array / scalar bodies are rejected, not 500s
			for (const bad of ['null', '[]', '"string"']) {
				const nullBody = await SELF.fetch(LOGIN_OPTIONS_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: bad,
				});
				expect(nullBody.status).toBe(400);
				expect(((await nullBody.json()) as { error: string }).error).toBe('invalid_json');
			}

			// Non-string names consume the ceremony and fail as name_required
			const { data: optionsData } = await getRegisterOptions(user.token!);
			const numericName = await doFetch(REGISTER_VERIFY_URL, user.token!, {
				ceremonyId: optionsData.ceremonyId,
				name: 12345,
				response: {},
			});
			expect(numericName.status).toBe(400);
			expect(((await numericName.json()) as { error: string }).error).toBe('name_required');
		});
	});
});
