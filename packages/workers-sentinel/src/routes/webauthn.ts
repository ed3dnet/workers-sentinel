import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { extractBearerToken } from '../middleware/auth';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

/** Public request-body cap for the login ceremony endpoints (8 KiB). */
const MAX_PUBLIC_BODY_BYTES = 8 * 1024;
/** Session-authed register bodies may carry attestation objects (64 KiB). */
const MAX_REGISTER_BODY_BYTES = 64 * 1024;

// One router, mounted at /api/auth/webauthn:
//   Public:   POST /login/options, POST /verify/login
//   Session:  POST /register/options, POST /verify/register,
//             GET  /credentials,      POST /credentials/delete
// authMiddleware (anonymous 401) is applied in index.ts for the session
// paths; the guard below additionally rejects `wst_` API tokens with 403 —
// AuthContext.session is synthesized for API tokens, so presence cannot
// discriminate and the raw bearer token prefix is the discriminator. An API
// token must not mint passkeys that would survive token revocation.
export const webauthnRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Session-only guard for the register/manage paths (tokens pattern)
const sessionOnlyGuard = async (
	c: {
		req: { header: (name: string) => string | undefined };
		json: (body: unknown, status: 403) => Response;
	},
	next: () => Promise<void>,
) => {
	const token = extractBearerToken(c.req.header('Authorization'));
	if (token?.startsWith('wst_')) {
		return c.json(
			{ error: 'session_required', message: 'Passkey management requires session authentication' },
			403,
		);
	}
	return next();
};

webauthnRoutes.use('/register/*', sessionOnlyGuard);
webauthnRoutes.use('/verify/register', sessionOnlyGuard);
webauthnRoutes.use('/credentials/*', sessionOnlyGuard);
webauthnRoutes.use('/credentials', sessionOnlyGuard);

/**
 * Trusted-origin policy — never merely the request's claim. Resolution per
 * request: the browser `Origin` header is accepted iff it equals the request
 * URL origin (same-origin, the prod SPA case) or is listed in
 * WEBAUTHN_ORIGINS (comma-separated exact origins, e.g. the vite dev proxy).
 * A rejected origin fails closed with 403; with no Origin header the request
 * URL origin is used. The accepted origin/rpID pair is pinned into the
 * challenge at options time and re-checked at verify.
 */
function resolveTrustedOrigin(
	env: Env,
	requestUrl: string,
	originHeader: string | undefined,
): { origin: string; rpID: string } | null {
	let selfOrigin: string;
	try {
		selfOrigin = new URL(requestUrl).origin;
	} catch {
		return null;
	}

	let accepted: string;
	if (originHeader) {
		if (originHeader === selfOrigin) {
			accepted = originHeader;
		} else {
			const allowlist = (env.WEBAUTHN_ORIGINS ?? '')
				.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean);
			if (!allowlist.includes(originHeader)) return null;
			accepted = originHeader;
		}
	} else {
		accepted = selfOrigin;
	}

	try {
		return { origin: accepted, rpID: new URL(accepted).hostname };
	} catch {
		return null;
	}
}

const originNotAllowed = { error: 'origin_not_allowed' } as const;

/** Fully discard the request body (workerd hygiene: never leave it unread). */
async function discardRequestBody(c: { req: { raw: Request } }): Promise<void> {
	await c.req.raw.body?.cancel().catch(() => undefined);
}

/** Reject an untrusted origin, consuming the request body first. */
async function rejectOrigin(c: {
	req: { raw: Request };
	json: (body: unknown, status: 403) => Response;
}): Promise<Response> {
	await discardRequestBody(c);
	return c.json({ ...originNotAllowed, message: 'Origin is not trusted' }, 403);
}

type PublicBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/**
 * Read a JSON request body while enforcing the size cap DURING streaming —
 * the body is never buffered beyond the cap (early Content-Length rejection
 * is only an optimization; chunked bodies are bounded chunk by chunk).
 */
async function readCappedBody(
	c: { req: { header: (name: string) => string | undefined; raw: Request } },
	maxBytes: number,
): Promise<PublicBody> {
	const declared = c.req.header('Content-Length');
	if (declared && Number(declared) > maxBytes) {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return { ok: false, response: Response.json(tooLarge, { status: 413 }) };
	}

	const reader = c.req.raw.body?.getReader();
	if (!reader) {
		return { ok: false, response: Response.json(badJson, { status: 400 }) };
	}
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return { ok: false, response: Response.json(tooLarge, { status: 413 }) };
		}
		chunks.push(value);
	}

	const assembled = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		assembled.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const parsed = JSON.parse(new TextDecoder().decode(assembled)) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ok: false, response: Response.json(badJson, { status: 400 }) };
		}
		return { ok: true, body: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, response: Response.json(badJson, { status: 400 }) };
	}
}

const tooLarge = { error: 'body_too_large', message: 'Request body exceeds the size limit' };
const badJson = { error: 'invalid_json', message: 'Request body must be a valid JSON object' };

function authStateFetcher(env: Env) {
	const id = env.AUTH_STATE.idFromName('global');
	const stub = env.AUTH_STATE.get(id);
	return (path: string, body: unknown) =>
		stub.fetch(
			new Request(`http://internal${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);
}

/** POST /api/auth/webauthn/login/options — public, optionally email-hinted. */
webauthnRoutes.post('/login/options', async (c) => {
	const trusted = resolveTrustedOrigin(c.env, c.req.url, c.req.header('Origin'));
	if (!trusted) return rejectOrigin(c);

	const parsed = await readCappedBody(c, MAX_PUBLIC_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const response = await authStateFetcher(c.env)('/webauthn/login/options', {
		email: typeof parsed.body.email === 'string' ? parsed.body.email : undefined,
		origin: trusted.origin,
		rpID: trusted.rpID,
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400);
});

/** POST /api/auth/webauthn/verify/login — public; issues a session on success. */
webauthnRoutes.post('/verify/login', async (c) => {
	const trusted = resolveTrustedOrigin(c.env, c.req.url, c.req.header('Origin'));
	if (!trusted) return rejectOrigin(c);

	const parsed = await readCappedBody(c, MAX_PUBLIC_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const response = await authStateFetcher(c.env)('/webauthn/login/verify', {
		ceremonyId: parsed.body.ceremonyId,
		response: parsed.body.response as AuthenticationResponseJSON | undefined,
		origin: trusted.origin,
		rpID: trusted.rpID,
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 401);
});

/** POST /api/auth/webauthn/register/options — session-only. */
webauthnRoutes.post('/register/options', async (c) => {
	const trusted = resolveTrustedOrigin(c.env, c.req.url, c.req.header('Origin'));
	if (!trusted) return rejectOrigin(c);

	// Consume and validate the (empty) body under the session-side cap
	const parsed = await readCappedBody(c, MAX_REGISTER_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const auth = c.get('auth') as AuthContext;
	const response = await authStateFetcher(c.env)('/webauthn/register/options', {
		userId: auth.user.id,
		origin: trusted.origin,
		rpID: trusted.rpID,
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 403 | 404);
});

/** POST /api/auth/webauthn/verify/register — session-only. */
webauthnRoutes.post('/verify/register', async (c) => {
	const trusted = resolveTrustedOrigin(c.env, c.req.url, c.req.header('Origin'));
	if (!trusted) return rejectOrigin(c);

	const auth = c.get('auth') as AuthContext;
	const parsed = await readCappedBody(c, MAX_REGISTER_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body as {
		ceremonyId?: string;
		name?: string;
		response?: RegistrationResponseJSON;
	};

	const response = await authStateFetcher(c.env)('/webauthn/register/verify', {
		userId: auth.user.id,
		ceremonyId: body.ceremonyId,
		name: body.name,
		response: body.response,
		origin: trusted.origin,
		rpID: trusted.rpID,
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 403 | 409);
});

/** GET /api/auth/webauthn/credentials — session-only. */
webauthnRoutes.get('/credentials', async (c) => {
	const auth = c.get('auth') as AuthContext;
	const response = await authStateFetcher(c.env)('/webauthn/credentials', {
		userId: auth.user.id,
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400);
});

/**
 * POST /api/auth/webauthn/credentials/delete — session-only. The credential
 * id travels in the body (base64url ids are 43 chars of mixed-case path
 * noise; body transport keeps URLs stable and cache/transport-friendly).
 */
webauthnRoutes.post('/credentials/delete', async (c) => {
	const auth = c.get('auth') as AuthContext;
	const parsed = await readCappedBody(c, MAX_REGISTER_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const response = await authStateFetcher(c.env)('/webauthn/credential/delete', {
		userId: auth.user.id,
		credentialId: typeof parsed.body.credentialId === 'string' ? parsed.body.credentialId : '',
	});
	const data = await response.json();
	return c.json(data, response.status as 200 | 400 | 404);
});
