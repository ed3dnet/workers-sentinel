// A real-crypto virtual authenticator for WebAuthn ceremony tests.
//
// Everything here uses the workerd WebCrypto implementation: an ES256
// (ECDSA P-256) keypair, SHA-256 rpIdHashes, and DER-encoded ECDSA
// signatures converted from WebCrypto's raw `r||s` output. A byte-level
// mistake cannot produce a passing ceremony — @simplewebauthn's verifiers
// are the oracle that validates this helper.

export interface CeremonyContext {
	/** base64url challenge from the server's options. */
	challenge: string;
	/** The origin the "browser" claims, e.g. `http://localhost`. */
	origin: string;
	/** The RP ID the authenticator binds into authenticatorData, e.g. `localhost`. */
	rpID: string;
	/** Optional user handle echoed in authentication responses. */
	userHandle?: string | null;
}

const encoder = new TextEncoder();

export function bytesToBase64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(text: string): Uint8Array {
	const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder (major types 0–5 only — all the attestation needs)
// ---------------------------------------------------------------------------

function cborHead(major: number, value: number, into: number[]): void {
	if (value < 24) {
		into.push((major << 5) | value);
	} else if (value < 0x100) {
		into.push((major << 5) | 24, value);
	} else if (value < 0x10000) {
		into.push((major << 5) | 25, value >> 8, value & 0xff);
	} else if (value < 0x100000000) {
		into.push(
			(major << 5) | 26,
			(value >> 24) & 0xff,
			(value >> 16) & 0xff,
			(value >> 8) & 0xff,
			value & 0xff,
		);
	} else {
		const hi = Math.floor(value / 0x100000000);
		const lo = value % 0x100000000;
		into.push(
			(major << 5) | 27,
			(hi >> 24) & 0xff,
			(hi >> 16) & 0xff,
			(hi >> 8) & 0xff,
			hi & 0xff,
			(lo >> 24) & 0xff,
			(lo >> 16) & 0xff,
			(lo >> 8) & 0xff,
			lo & 0xff,
		);
	}
}

type CborValue =
	| number
	| Uint8Array
	| string
	| CborValue[]
	| { [key: string]: CborValue }
	| Map<CborValue, CborValue>;

function cborEncode(value: CborValue, out: number[]): void {
	if (typeof value === 'number') {
		if (Number.isInteger(value) && value >= 0) {
			cborHead(0, value, out);
		} else {
			const n = Math.floor(value);
			cborHead(1, -n - 1, out);
		}
		return;
	}
	if (typeof value === 'string') {
		const bytes = encoder.encode(value);
		cborHead(3, bytes.length, out);
		out.push(...bytes);
		return;
	}
	if (value instanceof Uint8Array) {
		cborHead(2, value.length, out);
		out.push(...value);
		return;
	}
	if (Array.isArray(value)) {
		cborHead(4, value.length, out);
		for (const item of value) cborEncode(item, out);
		return;
	}
	if (value instanceof Map) {
		cborHead(5, value.size, out);
		for (const [key, item] of value) {
			cborEncode(key, out);
			cborEncode(item, out);
		}
		return;
	}
	const entries = Object.entries(value);
	cborHead(5, entries.length, out);
	for (const [key, item] of entries) {
		cborEncode(key, out);
		cborEncode(item, out);
	}
}

// ---------------------------------------------------------------------------
// DER signature encoding (WebCrypto emits raw 64-byte r||s)
// ---------------------------------------------------------------------------

function derInteger(bytes: Uint8Array): number[] {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start++;
	let payload = bytes.slice(start);
	if (payload[0] & 0x80) {
		payload = new Uint8Array([0, ...payload]);
	}
	return [0x02, payload.length, ...payload];
}

/** Raw 64-byte WebCrypto ECDSA signature → ASN.1 DER SEQUENCE(INTEGER r, INTEGER s). */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
	const r = derInteger(raw.slice(0, 32));
	const s = derInteger(raw.slice(32, 64));
	const body = [...r, ...s];
	return new Uint8Array([0x30, body.length, ...body]);
}

// ---------------------------------------------------------------------------
// WebAuthn structures
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
	return new Uint8Array(digest);
}

/** rpIdHash(32) | flags(1) | signCount(4, BE) | attestedCredentialData? */
async function authenticatorData(
	rpID: string,
	flags: number,
	counter: number,
	attestedCredentialData?: Uint8Array,
): Promise<Uint8Array> {
	const rpIdHash = await sha256(encoder.encode(rpID));
	const out = new Uint8Array(37 + (attestedCredentialData?.length ?? 0));
	out.set(rpIdHash, 0);
	out[32] = flags;
	out[33] = (counter >>> 24) & 0xff;
	out[34] = (counter >>> 16) & 0xff;
	out[35] = (counter >>> 8) & 0xff;
	out[36] = counter & 0xff;
	if (attestedCredentialData) out.set(attestedCredentialData, 37);
	return out;
}

/** COSE EC2 P-256 public key: {1: 2, 3: -7, -1: 1, -2: x, -3: y} */
function coseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
	const key = new Map<number, CborValue>([
		[1, 2], // kty: EC2
		[3, -7], // alg: ES256
		[-1, 1], // crv: P-256
		[-2, x], // x
		[-3, y], // y
	]);
	const out: number[] = [];
	cborEncode(key, out);
	return new Uint8Array(out);
}

/** aaguid(16) | credentialIdLength(2, BE) | credentialId | COSE key */
function attestedCredentialData(
	aaguid: Uint8Array,
	credentialId: Uint8Array,
	coseKey: Uint8Array,
): Uint8Array {
	const out = new Uint8Array(16 + 2 + credentialId.length + coseKey.length);
	out.set(aaguid, 0);
	out[16] = (credentialId.length >> 8) & 0xff;
	out[17] = credentialId.length & 0xff;
	out.set(credentialId, 18);
	out.set(coseKey, 18 + credentialId.length);
	return out;
}

function clientDataJSON(context: { type: string; challenge: string; origin: string }): Uint8Array {
	return encoder.encode(
		JSON.stringify({
			type: context.type,
			challenge: context.challenge,
			origin: context.origin,
			crossOrigin: false,
		}),
	);
}

/** attestationObject = {"fmt":"none","attStmt":{},"authData": bytes} */
function attestationObject(authData: Uint8Array): Uint8Array {
	const attObj = new Map<string, CborValue>([
		['fmt', 'none'],
		['attStmt', new Map()],
		['authData', authData],
	]);
	const out: number[] = [];
	cborEncode(attObj, out);
	return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// The authenticator
// ---------------------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface RegistrationResponseJSONLike {
	id: string;
	rawId: string;
	type: 'public-key';
	authenticatorAttachment?: string;
	clientExtensionResults: Record<string, never>;
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports: string[];
	};
}

export interface AuthenticationResponseJSONLike {
	id: string;
	rawId: string;
	type: 'public-key';
	authenticatorAttachment?: string;
	clientExtensionResults: Record<string, never>;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle: string | null;
	};
}

export class VirtualAuthenticator {
	readonly credentialId: Uint8Array;
	private privateKey: CryptoKey | null = null;
	private x: Uint8Array | null = null;
	private y: Uint8Array | null = null;
	counter = 0;

	constructor(private readonly aaguid = new Uint8Array(16)) {
		this.credentialId = crypto.getRandomValues(new Uint8Array(32));
	}

	async init(): Promise<void> {
		const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		this.privateKey = pair.privateKey;
		const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
		this.x = base64urlToBytes(jwk.x as string);
		this.y = base64urlToBytes(jwk.y as string);
	}

	get credentialIdBase64url(): string {
		return bytesToBase64url(this.credentialId);
	}

	async createRegistrationResponse(
		context: CeremonyContext,
	): Promise<RegistrationResponseJSONLike> {
		if (!this.privateKey || !this.x || !this.y)
			throw new Error('VirtualAuthenticator not initialized');

		const coseKey = coseEc2Key(this.x, this.y);
		const acd = attestedCredentialData(this.aaguid, this.credentialId, coseKey);
		const authData = await authenticatorData(
			context.rpID,
			FLAG_UP | FLAG_UV | FLAG_AT,
			this.counter,
			acd,
		);
		const clientData = clientDataJSON({
			type: 'webauthn.create',
			challenge: context.challenge,
			origin: context.origin,
		});

		return {
			id: this.credentialIdBase64url,
			rawId: this.credentialIdBase64url,
			type: 'public-key',
			authenticatorAttachment: 'cross-platform',
			clientExtensionResults: {},
			response: {
				clientDataJSON: bytesToBase64url(clientData),
				attestationObject: bytesToBase64url(attestationObject(authData)),
				transports: ['usb'],
			},
		};
	}

	async createAuthenticationResponse(
		context: CeremonyContext,
	): Promise<AuthenticationResponseJSONLike> {
		if (!this.privateKey) throw new Error('VirtualAuthenticator not initialized');

		this.counter += 1;
		const authData = await authenticatorData(context.rpID, FLAG_UP | FLAG_UV, this.counter);
		const clientData = clientDataJSON({
			type: 'webauthn.get',
			challenge: context.challenge,
			origin: context.origin,
		});

		// The assertion signature covers authenticatorData || SHA-256(clientDataJSON)
		const clientDataHash = await sha256(clientData);
		const signed = new Uint8Array(authData.length + clientDataHash.length);
		signed.set(authData, 0);
		signed.set(clientDataHash, authData.length);
		const rawSignature = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			this.privateKey,
			signed as unknown as ArrayBuffer,
		);

		return {
			id: this.credentialIdBase64url,
			rawId: this.credentialIdBase64url,
			type: 'public-key',
			authenticatorAttachment: 'cross-platform',
			clientExtensionResults: {},
			response: {
				clientDataJSON: bytesToBase64url(clientData),
				authenticatorData: bytesToBase64url(authData),
				signature: bytesToBase64url(rawSignatureToDer(new Uint8Array(rawSignature))),
				userHandle: context.userHandle ?? null,
			},
		};
	}
}
