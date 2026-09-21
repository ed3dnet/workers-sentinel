import { DurableObject } from 'cloudflare:workers';
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { hashPassword, hashToken, verifyPassword } from '../lib/password';
import { validateWebhookUrl } from '../lib/webhook';
import type {
	ApiToken,
	Env,
	Project,
	ProjectMember,
	Session,
	User,
	WebauthnCredentialInfo,
} from '../types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'javascript',
  public_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_public_key ON projects(public_key);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_prefix TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  aaguid TEXT,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  ceremony_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  challenge TEXT NOT NULL,
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_bucket ON webauthn_challenges(kind, user_id);
`;

/** WebAuthn challenge lifetime (5 minutes) and issuance caps. */
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const WEBAUTHN_MAX_CHALLENGES_PER_BUCKET = 10;
const WEBAUTHN_MAX_TOTAL_CHALLENGES = 500;

// Login must burn argon2 even when the user does not exist, so response
// timing does not reveal account existence.
let dummyHashCache: string | null = null;
function dummyPasswordHash(): string {
	dummyHashCache ??= hashPassword('sentinel-timing-equalizer');
	return dummyHashCache;
}

function bytesToBase64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
	const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Exact-copy ArrayBuffer for a BLOB bind parameter. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/** Normalize a BLOB column value (ArrayBuffer or Uint8Array) to Uint8Array. */
function blobToBytes(value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
	if (value instanceof Uint8Array) {
		const copy = new Uint8Array(value.length);
		copy.set(value);
		return copy;
	}
	return new Uint8Array(value);
}

/** Stored transports JSON (written by JSON.stringify) back to the lib type. */
function parseTransports(text: unknown): AuthenticatorTransportFuture[] | undefined {
	return typeof text === 'string' && text
		? (JSON.parse(text) as AuthenticatorTransportFuture[])
		: undefined;
}

export class AuthState extends DurableObject<Env> {
	private sql: SqlStorage;
	private initialized = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
	}

	private async ensureSchema(): Promise<void> {
		if (this.initialized) return;
		this.sql.exec(SCHEMA);
		// Migration: add webhook_url column
		try {
			this.sql.exec('ALTER TABLE projects ADD COLUMN webhook_url TEXT');
		} catch {
			// Column already exists
		}
		// Migration: add disabled flag on users
		try {
			this.sql.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
		} catch {
			// Column already exists
		}
		// Migration: add the stable opaque WebAuthn user handle (never email;
		// minted lazily on first passkey registration)
		try {
			this.sql.exec('ALTER TABLE users ADD COLUMN webauthn_user_id TEXT');
		} catch {
			// Column already exists
		}
		this.initialized = true;
	}

	/** Seconds remaining on a throttle lock, or 0 when not locked. */
	private throttleLocked(key: string): number {
		const rows = this.sql
			.exec('SELECT locked_until FROM auth_throttle WHERE key = ?', key)
			.toArray();
		if (rows.length === 0 || !rows[0].locked_until) return 0;
		const remaining = new Date(rows[0].locked_until as string).getTime() - Date.now();
		if (remaining <= 0) return 0;
		return Math.ceil(remaining / 1000);
	}

	/** Record a failure; locks the key for lockMs once count reaches max within windowMs. */
	private throttleFailure(key: string, max: number, windowMs: number, lockMs: number): void {
		const now = new Date();
		const rows = this.sql
			.exec('SELECT count, window_start FROM auth_throttle WHERE key = ?', key)
			.toArray();
		if (rows.length === 0) {
			this.sql.exec(
				'INSERT INTO auth_throttle (key, count, window_start, locked_until) VALUES (?, 1, ?, NULL)',
				key,
				now.toISOString(),
			);
			return;
		}
		const windowStart = new Date(rows[0].window_start as string).getTime();
		const count = (rows[0].count as number) + 1;
		if (Date.now() - windowStart > windowMs) {
			// Window expired: restart the count
			this.sql.exec(
				'UPDATE auth_throttle SET count = 1, window_start = ?, locked_until = NULL WHERE key = ?',
				now.toISOString(),
				key,
			);
			return;
		}
		if (count >= max) {
			const lockedUntil = new Date(now.getTime() + lockMs).toISOString();
			this.sql.exec(
				'UPDATE auth_throttle SET count = ?, locked_until = ? WHERE key = ?',
				count,
				lockedUntil,
				key,
			);
			return;
		}
		this.sql.exec('UPDATE auth_throttle SET count = ? WHERE key = ?', count, key);
	}

	private throttleClear(key: string): void {
		this.sql.exec('DELETE FROM auth_throttle WHERE key = ?', key);
	}

	private getSetting(key: string): string | null {
		const rows = this.sql.exec('SELECT value FROM settings WHERE key = ?', key).toArray();
		return rows.length > 0 ? (rows[0].value as string) : null;
	}

	private setSetting(key: string, value: string): void {
		this.sql.exec(
			'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
			key,
			value,
		);
	}

	private static readonly EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	async fetch(request: Request): Promise<Response> {
		await this.ensureSchema();

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			switch (path) {
				case '/register':
					return this.handleRegister(request);
				case '/login':
					return this.handleLogin(request);
				case '/logout':
					return this.handleLogout(request);
				case '/logout-all':
					return this.handleLogoutAll(request);
				case '/change-password':
					return this.handleChangePassword(request);
				case '/admin/set-user-disabled':
					return this.handleAdminSetUserDisabled(request);
				case '/validate-session':
					return this.handleValidateSession(request);
				case '/me':
					return this.handleGetMe(request);
				case '/create-project':
					return this.handleCreateProject(request);
				case '/list-projects':
					return this.handleListProjects(request);
				case '/get-project':
					return this.handleGetProject(request);
				case '/get-project-by-key':
					return this.handleGetProjectByKey(request);
				case '/delete-project':
					return this.handleDeleteProject(request);
				case '/update-project':
					return this.handleUpdateProject(request);
				case '/check-access':
					return this.handleCheckAccess(request);
				case '/create-api-token':
					return this.handleCreateApiToken(request);
				case '/list-api-tokens':
					return this.handleListApiTokens(request);
				case '/revoke-api-token':
					return this.handleRevokeApiToken(request);
				case '/validate-api-token':
					return this.handleValidateApiToken(request);
				case '/list-project-members':
					return this.handleListProjectMembers(request);
				case '/add-project-member':
					return this.handleAddProjectMember(request);
				case '/remove-project-member':
					return this.handleRemoveProjectMember(request);
				case '/update-project-member':
					return this.handleUpdateProjectMember(request);
				case '/list-users':
					return this.handleListUsers(request);
				case '/get-settings':
					return this.handleGetSettings(request);
				case '/set-settings':
					return this.handleSetSettings(request);
				case '/webauthn/register/options':
					return this.handleWebauthnRegisterOptions(request);
				case '/webauthn/register/verify':
					return this.handleWebauthnRegisterVerify(request);
				case '/webauthn/login/options':
					return this.handleWebauthnLoginOptions(request);
				case '/webauthn/login/verify':
					return this.handleWebauthnLoginVerify(request);
				case '/webauthn/credentials':
					return this.handleWebauthnListCredentials(request);
				case '/webauthn/credential/delete':
					return this.handleWebauthnDeleteCredential(request);
				case '/webauthn/test/backdate-ceremony':
					return this.handleWebauthnTestBackdate(request);
				case '/webauthn/test/challenge-count':
					return this.handleWebauthnTestChallengeCount();
				default:
					return new Response(JSON.stringify({ error: 'not_found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' },
					});
			}
		} catch (error) {
			console.error('AuthState error:', error);
			return new Response(
				JSON.stringify({
					error: 'internal_error',
					message: error instanceof Error ? error.message : 'Unknown error',
				}),
				{ status: 500, headers: { 'Content-Type': 'application/json' } },
			);
		}
	}

	private async handleRegister(request: Request): Promise<Response> {
		const { email, password, name, ip, setupToken } = (await request.json()) as {
			email?: string;
			password?: string;
			name?: string;
			ip?: string;
			setupToken?: string;
		};

		const normalizedEmail = (email ?? '').trim().toLowerCase();
		const trimmedName = (name ?? '').trim();
		if (!normalizedEmail || !password || !trimmedName) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'Email, password, and name are required' },
				400,
			);
		}
		if (normalizedEmail.length > 254 || !AuthState.EMAIL_PATTERN.test(normalizedEmail)) {
			return this.jsonResponse({ error: 'invalid_email', message: 'Invalid email address' }, 400);
		}
		if (password.length < 8 || password.length > 1024) {
			return this.jsonResponse(
				{ error: 'invalid_password', message: 'Password must be between 8 and 1024 characters' },
				400,
			);
		}
		if (trimmedName.length > 100) {
			return this.jsonResponse(
				{ error: 'invalid_name', message: 'Name must be at most 100 characters' },
				400,
			);
		}

		// Registration rate limit per client IP (only enforceable when an IP is
		// known; Cloudflare always provides CF-Connecting-IP in production)
		if (ip) {
			const key = `register:${ip}`;
			const locked = this.throttleLocked(key);
			if (locked > 0) {
				return this.jsonResponse(
					{
						error: 'too_many_requests',
						message: 'Too many registrations; try again later',
						retryAfter: locked,
					},
					429,
				);
			}
			this.throttleFailure(key, 5, 60 * 60 * 1000, 60 * 60 * 1000);
		}

		// Check if user already exists
		const existing = this.sql
			.exec('SELECT id FROM users WHERE email = ?', normalizedEmail)
			.toArray();
		if (existing.length > 0) {
			return this.jsonResponse(
				{ error: 'user_exists', message: 'User with this email already exists' },
				409,
			);
		}

		// Check if this is the first user (becomes admin)
		const userCount = this.sql.exec('SELECT COUNT(*) as count FROM users').one();
		const isFirstUser = (userCount?.count as number) === 0;

		// Registration controls: closed registration blocks non-first signups;
		// first signup on a fresh install may require the operator's setup token.
		if (!isFirstUser && this.getSetting('registration_open') === 'false') {
			return this.jsonResponse(
				{ error: 'registration_disabled', message: 'Registration is disabled on this server' },
				403,
			);
		}
		const envSetupToken = this.env.SETUP_TOKEN;
		if (isFirstUser && envSetupToken && setupToken !== envSetupToken) {
			return this.jsonResponse(
				{
					error: 'setup_token_required',
					message: 'First registration requires the server setup token',
				},
				403,
			);
		}

		// Hash password (argon2id)
		const passwordHash = hashPassword(password);

		// Create user
		const userId = crypto.randomUUID();
		const now = new Date().toISOString();
		const role = isFirstUser ? 'admin' : 'member';

		this.sql.exec(
			'INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			userId,
			normalizedEmail,
			passwordHash,
			trimmedName,
			role,
			now,
			now,
		);

		// Create session
		const session = await this.createSession(userId);

		const user: User = {
			id: userId,
			email: normalizedEmail,
			name: trimmedName,
			role: role as 'admin' | 'member',
			createdAt: now,
			updatedAt: now,
		};

		return this.jsonResponse({ user, token: session.id });
	}

	private async handleLogin(request: Request): Promise<Response> {
		const { email, password } = (await request.json()) as {
			email?: string;
			password?: string;
		};

		if (!email || !password) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'Email and password are required' },
				400,
			);
		}
		const normalizedEmail = email.trim().toLowerCase();
		const throttleKey = `login:${normalizedEmail}`;
		const locked = this.throttleLocked(throttleKey);
		if (locked > 0) {
			return this.jsonResponse(
				{
					error: 'too_many_attempts',
					message: 'Too many failed attempts; try again later',
					retryAfter: locked,
				},
				429,
			);
		}

		// Find user
		const userRows = this.sql
			.exec(
				'SELECT id, email, password_hash, name, role, disabled, created_at, updated_at FROM users WHERE email = ?',
				normalizedEmail,
			)
			.toArray();

		if (userRows.length === 0) {
			// Burn argon2 anyway so timing does not reveal account existence
			verifyPassword(password, dummyPasswordHash());
			this.throttleFailure(throttleKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
			return this.jsonResponse(
				{ error: 'invalid_credentials', message: 'Invalid email or password' },
				401,
			);
		}

		const userRow = userRows[0];

		// Verify password (argon2id, with transparent upgrade of legacy SHA-256 hashes)
		const verification = verifyPassword(password, userRow.password_hash as string);
		if (verification.ok && verification.needsRehash) {
			this.sql.exec(
				'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
				hashPassword(password),
				new Date().toISOString(),
				userRow.id as string,
			);
		}
		if (!verification.ok || (userRow.disabled as number) === 1) {
			this.throttleFailure(throttleKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
			// Uniform error for wrong password and disabled account
			return this.jsonResponse(
				{ error: 'invalid_credentials', message: 'Invalid email or password' },
				401,
			);
		}

		this.throttleClear(throttleKey);

		// Create session
		const session = await this.createSession(userRow.id as string);

		const user: User = {
			id: userRow.id as string,
			email: userRow.email as string,
			name: userRow.name as string,
			role: userRow.role as 'admin' | 'member',
			createdAt: userRow.created_at as string,
			updatedAt: userRow.updated_at as string,
		};

		// Additive: lets the client know the passkey nag state immediately
		return this.jsonResponse({
			user,
			token: session.id,
			hasPasskey: this.hasPasskey(userRow.id as string),
		});
	}

	private async handleLogout(request: Request): Promise<Response> {
		const { token } = (await request.json()) as { token: string };

		if (token) {
			// Sessions are stored hashed; look up by the hash of the presented token
			this.sql.exec('DELETE FROM sessions WHERE id = ?', hashToken(token));
		}

		return this.jsonResponse({ success: true });
	}

	private async handleLogoutAll(request: Request): Promise<Response> {
		const { userId } = (await request.json()) as { userId: string };
		if (!userId) {
			return this.jsonResponse({ error: 'missing_user_id' }, 400);
		}
		this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
		return this.jsonResponse({ success: true });
	}

	private async handleChangePassword(request: Request): Promise<Response> {
		const { userId, currentPassword, newPassword } = (await request.json()) as {
			userId?: string;
			currentPassword?: string;
			newPassword?: string;
		};
		if (!userId || !currentPassword || !newPassword) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}
		if (newPassword.length < 8 || newPassword.length > 1024) {
			return this.jsonResponse(
				{
					error: 'invalid_password',
					message: 'New password must be between 8 and 1024 characters',
				},
				400,
			);
		}
		const rows = this.sql
			.exec('SELECT id, password_hash FROM users WHERE id = ?', userId)
			.toArray();
		if (rows.length === 0) {
			return this.jsonResponse({ error: 'not_found' }, 404);
		}
		// Re-authenticate: the current password is required to change it
		const verification = verifyPassword(currentPassword, rows[0].password_hash as string);
		if (!verification.ok) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}
		this.sql.exec(
			'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
			hashPassword(newPassword),
			new Date().toISOString(),
			userId,
		);
		// Revoke every session: other sessions must re-authenticate
		this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
		return this.jsonResponse({ success: true });
	}

	private async handleAdminSetUserDisabled(request: Request): Promise<Response> {
		const { requestingUserRole, userId, disabled } = (await request.json()) as {
			requestingUserRole?: string;
			userId?: string;
			disabled?: boolean;
		};
		if (requestingUserRole !== 'admin') {
			return this.jsonResponse({ error: 'forbidden', message: 'Admin role required' }, 403);
		}
		if (!userId || typeof disabled !== 'boolean') {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}
		const rows = this.sql.exec('SELECT id, role FROM users WHERE id = ?', userId).toArray();
		if (rows.length === 0) {
			return this.jsonResponse({ error: 'not_found' }, 404);
		}
		if (rows[0].role === 'admin') {
			return this.jsonResponse(
				{ error: 'forbidden', message: 'Admins cannot be disabled by this endpoint' },
				403,
			);
		}
		this.sql.exec(
			'UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?',
			disabled ? 1 : 0,
			new Date().toISOString(),
			userId,
		);
		if (disabled) {
			// Kill live sessions immediately
			this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
		}
		return this.jsonResponse({ success: true, userId, disabled });
	}

	private async handleValidateSession(request: Request): Promise<Response> {
		const { token } = (await request.json()) as { token: string };

		if (!token) {
			return this.jsonResponse({ error: 'missing_token' }, 400);
		}

		// Clean expired sessions periodically
		await this.cleanExpiredSessions();

		// Get session with user
		const rows = this.sql
			.exec(
				`SELECT s.id as session_id, s.expires_at, s.created_at as session_created,
              u.id as user_id, u.email, u.name, u.role, u.created_at, u.updated_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
				hashToken(token),
				new Date().toISOString(),
			)
			.toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'invalid_session' }, 401);
		}

		const row = rows[0];

		const user: User = {
			id: row.user_id as string,
			email: row.email as string,
			name: row.name as string,
			role: row.role as 'admin' | 'member',
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};

		const session: Session = {
			id: row.session_id as string,
			userId: row.user_id as string,
			expiresAt: row.expires_at as string,
			createdAt: row.session_created as string,
		};

		return this.jsonResponse({ user, session, hasPasskey: this.hasPasskey(row.user_id as string) });
	}

	private async handleGetMe(request: Request): Promise<Response> {
		const { token } = (await request.json()) as { token: string };
		return this.handleValidateSession(
			new Request(request.url, {
				method: 'POST',
				body: JSON.stringify({ token }),
			}),
		);
	}

	private async handleCreateProject(request: Request): Promise<Response> {
		const { name, platform, userId } = (await request.json()) as {
			name: string;
			platform?: string;
			userId: string;
		};

		if (!name || !userId) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'Name and userId are required' },
				400,
			);
		}

		// Generate unique slug
		const baseSlug = this.slugify(name);
		let slug = baseSlug;
		let counter = 1;
		while (this.sql.exec('SELECT id FROM projects WHERE slug = ?', slug).toArray().length > 0) {
			slug = `${baseSlug}-${counter}`;
			counter++;
		}

		// Generate public key for DSN
		const publicKey = this.generateKey(32);

		const projectId = crypto.randomUUID();
		const now = new Date().toISOString();

		this.sql.exec(
			'INSERT INTO projects (id, name, slug, platform, public_key, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
			projectId,
			name,
			slug,
			platform || 'javascript',
			publicKey,
			now,
			userId,
		);

		// Add creator as owner
		this.sql.exec(
			'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
			projectId,
			userId,
			'owner',
			now,
		);

		const project: Project = {
			id: projectId,
			name,
			slug,
			platform: platform || 'javascript',
			publicKey,
			createdAt: now,
			createdBy: userId,
		};

		return this.jsonResponse({ project });
	}

	private async handleListProjects(request: Request): Promise<Response> {
		const { userId } = (await request.json()) as { userId: string };

		if (!userId) {
			return this.jsonResponse({ error: 'missing_user_id' }, 400);
		}

		const rows = this.sql
			.exec(
				`SELECT p.id, p.name, p.slug, p.platform, p.public_key, p.webhook_url, p.created_at, p.created_by, pm.role as member_role
       FROM projects p
       JOIN project_members pm ON p.id = pm.project_id
       WHERE pm.user_id = ?
       ORDER BY p.created_at DESC`,
				userId,
			)
			.toArray();

		const projects = rows.map((row) => ({
			id: row.id as string,
			name: row.name as string,
			slug: row.slug as string,
			platform: row.platform as string,
			publicKey: row.public_key as string,
			// Webhook URLs embed provider auth tokens: hide them from members
			webhookUrl: row.member_role === 'member' ? null : (row.webhook_url as string) || null,
			createdAt: row.created_at as string,
			createdBy: row.created_by as string,
			memberRole: row.member_role as string,
		}));

		return this.jsonResponse({ projects });
	}

	private async handleGetProject(request: Request): Promise<Response> {
		const { slug, userId, alsoTryId } = (await request.json()) as {
			slug?: string;
			userId?: string;
			alsoTryId?: boolean;
		};

		if (!slug) {
			return this.jsonResponse({ error: 'missing_slug' }, 400);
		}
		if (!userId) {
			// Membership is mandatory: no unscoped project lookups
			return this.jsonResponse({ error: 'missing_user' }, 400);
		}

		const select = `SELECT p.id, p.name, p.slug, p.platform, p.public_key, p.webhook_url, p.created_at, p.created_by, pm.role as member_role
       FROM projects p
       JOIN project_members pm ON p.id = pm.project_id AND pm.user_id = ?`;

		let rows = this.sql.exec(`${select} WHERE p.slug = ?`, userId, slug).toArray();

		// Sentry /api/0 compat surface resolves projects by numeric id as a
		// fallback (Sentry accepts {project_id_or_slug} path segments). The
		// slug match takes precedence, and the id retry runs under the same
		// membership JOIN — a non-member probing by id learns nothing more
		// than the same uniform 404. The compat route is the only caller
		// passing alsoTryId; the native slug path is unchanged.
		if (rows.length === 0 && alsoTryId) {
			rows = this.sql.exec(`${select} WHERE p.id = ?`, userId, slug).toArray();
		}

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'project_not_found' }, 404);
		}

		const row = rows[0];
		const memberRole = row.member_role as string;

		const project: Project = {
			id: row.id as string,
			name: row.name as string,
			slug: row.slug as string,
			platform: row.platform as string,
			publicKey: row.public_key as string,
			// Webhook URLs embed provider auth tokens: hide them from members
			webhookUrl: memberRole === 'member' ? null : (row.webhook_url as string) || null,
			createdAt: row.created_at as string,
			createdBy: row.created_by as string,
		};

		return this.jsonResponse({ project, memberRole });
	}

	private async handleGetProjectByKey(request: Request): Promise<Response> {
		const { publicKey } = (await request.json()) as { publicKey: string };

		if (!publicKey) {
			return this.jsonResponse({ error: 'missing_key' }, 400);
		}

		const rows = this.sql
			.exec(
				'SELECT id, name, slug, platform, public_key, webhook_url, created_at, created_by FROM projects WHERE public_key = ?',
				publicKey,
			)
			.toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'project_not_found' }, 404);
		}

		const row = rows[0];

		const project: Project = {
			id: row.id as string,
			name: row.name as string,
			slug: row.slug as string,
			platform: row.platform as string,
			publicKey: row.public_key as string,
			webhookUrl: (row.webhook_url as string) || null,
			createdAt: row.created_at as string,
			createdBy: row.created_by as string,
		};

		return this.jsonResponse({ project });
	}

	private async handleDeleteProject(request: Request): Promise<Response> {
		const { projectId, userId } = (await request.json()) as { projectId: string; userId: string };

		if (!projectId || !userId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		// Check if user is owner
		const memberRows = this.sql
			.exec(
				'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
				projectId,
				userId,
			)
			.toArray();

		if (memberRows.length === 0 || memberRows[0].role !== 'owner') {
			return this.jsonResponse(
				{ error: 'forbidden', message: 'Only project owner can delete' },
				403,
			);
		}

		// Delete project (cascade deletes members)
		this.sql.exec('DELETE FROM projects WHERE id = ?', projectId);

		return this.jsonResponse({ success: true });
	}

	private async handleUpdateProject(request: Request): Promise<Response> {
		const { projectId, userId, webhookUrl } = (await request.json()) as {
			projectId: string;
			userId: string;
			webhookUrl?: string | null;
		};

		if (!projectId || !userId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		// Check user has access
		const memberRows = this.sql
			.exec(
				'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
				projectId,
				userId,
			)
			.toArray();

		if (memberRows.length === 0) {
			return this.jsonResponse({ error: 'forbidden', message: 'No access to this project' }, 403);
		}

		// Only owner/admin can update settings
		const role = memberRows[0].role as string;
		if (role !== 'owner' && role !== 'admin') {
			return this.jsonResponse(
				{ error: 'forbidden', message: 'Only owner or admin can update settings' },
				403,
			);
		}

		// Validate webhook URL (https only, no private/loopback hosts, no
		// embedded credentials; redirects are refused at delivery time)
		if (webhookUrl) {
			const validated = validateWebhookUrl(webhookUrl);
			if (!validated.ok) {
				return this.jsonResponse(
					{ error: 'invalid_url', message: `Invalid webhook URL: ${validated.reason}` },
					400,
				);
			}
		}

		const updates: string[] = [];
		const params: (string | null)[] = [];

		if (webhookUrl !== undefined) {
			updates.push('webhook_url = ?');
			params.push(webhookUrl || null);
		}

		if (updates.length === 0) {
			return this.jsonResponse({ error: 'no_updates' }, 400);
		}

		params.push(projectId);
		this.sql.exec(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, ...params);

		return this.jsonResponse({ success: true });
	}

	private async handleCheckAccess(request: Request): Promise<Response> {
		const { projectId, userId } = (await request.json()) as { projectId: string; userId: string };

		if (!projectId || !userId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		const memberRows = this.sql
			.exec(
				'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
				projectId,
				userId,
			)
			.toArray();

		const member = memberRows.length > 0 ? memberRows[0] : null;
		return this.jsonResponse({
			hasAccess: !!member,
			role: member?.role || null,
		});
	}

	private async handleCreateApiToken(request: Request): Promise<Response> {
		const { userId, name, expiresAt } = (await request.json()) as {
			userId: string;
			name: string;
			expiresAt?: string;
		};

		if (!userId || !name) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'userId and name are required' },
				400,
			);
		}

		// Validate expiresAt if provided
		if (expiresAt !== undefined && expiresAt !== null) {
			const expiry = new Date(expiresAt);
			if (isNaN(expiry.getTime())) {
				return this.jsonResponse(
					{ error: 'invalid_date', message: 'expiresAt must be a valid ISO date string' },
					400,
				);
			}
			if (expiry <= new Date()) {
				return this.jsonResponse(
					{ error: 'invalid_date', message: 'expiresAt must be a future date' },
					400,
				);
			}
		}

		// Limit: max 10 tokens per user
		const countResult = this.sql
			.exec('SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ?', userId)
			.one();
		if ((countResult?.count as number) >= 10) {
			return this.jsonResponse(
				{ error: 'limit_exceeded', message: 'Maximum of 10 API tokens per user' },
				400,
			);
		}

		// Generate raw token: wst_ + 64 hex chars
		const rawToken = `wst_${this.generateKey(64)}`;

		// Hash the token for storage. High-entropy random tokens only need a
		// fast lookup hash (argon2 would add ~250ms to every authenticated
		// request without security benefit at this entropy).
		const tokenHash = hashToken(rawToken);

		const tokenId = crypto.randomUUID();
		const tokenPrefix = rawToken.slice(0, 12);
		const now = new Date().toISOString();

		this.sql.exec(
			'INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			tokenId,
			userId,
			name,
			tokenHash,
			tokenPrefix,
			expiresAt || null,
			now,
		);

		const token: ApiToken = {
			id: tokenId,
			userId,
			name,
			tokenPrefix,
			lastUsedAt: null,
			expiresAt: expiresAt || null,
			createdAt: now,
		};

		return this.jsonResponse({ token, rawToken });
	}

	private async handleListApiTokens(request: Request): Promise<Response> {
		const { userId } = (await request.json()) as { userId: string };

		if (!userId) {
			return this.jsonResponse({ error: 'missing_user_id' }, 400);
		}

		const rows = this.sql
			.exec(
				'SELECT id, user_id, name, token_prefix, last_used_at, expires_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
				userId,
			)
			.toArray();

		const tokens: ApiToken[] = rows.map((row) => ({
			id: row.id as string,
			userId: row.user_id as string,
			name: row.name as string,
			tokenPrefix: row.token_prefix as string,
			lastUsedAt: (row.last_used_at as string) || null,
			expiresAt: (row.expires_at as string) || null,
			createdAt: row.created_at as string,
		}));

		return this.jsonResponse({ tokens });
	}

	private async handleRevokeApiToken(request: Request): Promise<Response> {
		const { tokenId, userId } = (await request.json()) as {
			tokenId: string;
			userId: string;
		};

		if (!tokenId || !userId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		// Verify the token belongs to the user
		const rows = this.sql
			.exec('SELECT id FROM api_tokens WHERE id = ? AND user_id = ?', tokenId, userId)
			.toArray();

		if (rows.length === 0) {
			return this.jsonResponse(
				{ error: 'not_found', message: 'Token not found or does not belong to user' },
				404,
			);
		}

		this.sql.exec('DELETE FROM api_tokens WHERE id = ?', tokenId);

		return this.jsonResponse({ success: true });
	}

	private async handleValidateApiToken(request: Request): Promise<Response> {
		const { token } = (await request.json()) as { token: string };

		if (!token || !token.startsWith('wst_')) {
			return this.jsonResponse({ error: 'invalid_token' }, 401);
		}

		// Hash the token and look it up
		const tokenHash = hashToken(token);

		const rows = this.sql
			.exec(
				`SELECT t.id as token_id, t.user_id, t.expires_at,
				u.id as uid, u.email, u.name, u.role, u.created_at, u.updated_at
				FROM api_tokens t
				JOIN users u ON t.user_id = u.id
				WHERE t.token_hash = ? AND u.disabled = 0`,
				tokenHash,
			)
			.toArray();

		if (rows.length === 0) {
			return this.jsonResponse({ error: 'invalid_token' }, 401);
		}

		const row = rows[0];

		// Check expiration
		const expiresAt = row.expires_at as string | null;
		if (expiresAt && new Date(expiresAt) < new Date()) {
			return this.jsonResponse({ error: 'token_expired' }, 401);
		}

		// Update last_used_at
		this.sql.exec(
			'UPDATE api_tokens SET last_used_at = ? WHERE id = ?',
			new Date().toISOString(),
			row.token_id as string,
		);

		const user: User = {
			id: row.uid as string,
			email: row.email as string,
			name: row.name as string,
			role: row.role as 'admin' | 'member',
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};

		// Return in the same format as session validation
		const session: Session = {
			id: row.token_id as string,
			userId: row.uid as string,
			expiresAt: expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
			createdAt: row.created_at as string,
		};

		return this.jsonResponse({ user, session });
	}

	private async handleListProjectMembers(request: Request): Promise<Response> {
		const { projectId } = (await request.json()) as { projectId: string };

		if (!projectId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		const rows = this.sql
			.exec(
				`SELECT pm.user_id, pm.role, pm.created_at, u.email, u.name
				FROM project_members pm
				JOIN users u ON pm.user_id = u.id
				WHERE pm.project_id = ?
				ORDER BY pm.created_at ASC`,
				projectId,
			)
			.toArray();

		const members: ProjectMember[] = rows.map((row) => ({
			userId: row.user_id as string,
			email: row.email as string,
			name: row.name as string,
			role: row.role as 'owner' | 'admin' | 'member',
			createdAt: row.created_at as string,
		}));

		return this.jsonResponse({ members });
	}

	private async handleAddProjectMember(request: Request): Promise<Response> {
		const { projectId, email, role } = (await request.json()) as {
			projectId: string;
			email: string;
			role: string;
		};

		if (!projectId || !email || !role) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'projectId, email, and role are required' },
				400,
			);
		}

		if (role !== 'admin' && role !== 'member') {
			return this.jsonResponse(
				{ error: 'invalid_role', message: 'Role must be admin or member' },
				400,
			);
		}

		// Look up user by email
		const userRows = this.sql
			.exec('SELECT id, email, name FROM users WHERE email = ?', email.toLowerCase())
			.toArray();

		if (userRows.length === 0) {
			return this.jsonResponse(
				{ error: 'user_not_found', message: 'No user found with that email' },
				404,
			);
		}

		const user = userRows[0];
		const userId = user.id as string;

		// Check if already a member
		const existing = this.sql
			.exec('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId)
			.toArray();

		if (existing.length > 0) {
			return this.jsonResponse(
				{ error: 'already_member', message: 'User is already a member of this project' },
				409,
			);
		}

		const now = new Date().toISOString();
		this.sql.exec(
			'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
			projectId,
			userId,
			role,
			now,
		);

		const member: ProjectMember = {
			userId,
			email: user.email as string,
			name: user.name as string,
			role: role as 'admin' | 'member',
			createdAt: now,
		};

		return this.jsonResponse({ member });
	}

	private async handleRemoveProjectMember(request: Request): Promise<Response> {
		const { projectId, userId } = (await request.json()) as {
			projectId: string;
			userId: string;
		};

		if (!projectId || !userId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		// Check that the user being removed is NOT the owner
		const memberRows = this.sql
			.exec(
				'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
				projectId,
				userId,
			)
			.toArray();

		if (memberRows.length === 0) {
			return this.jsonResponse(
				{ error: 'not_found', message: 'User is not a member of this project' },
				404,
			);
		}

		if (memberRows[0].role === 'owner') {
			return this.jsonResponse(
				{ error: 'cannot_remove_owner', message: 'Cannot remove the project owner' },
				400,
			);
		}

		this.sql.exec(
			'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
			projectId,
			userId,
		);

		return this.jsonResponse({ success: true });
	}

	private async handleUpdateProjectMember(request: Request): Promise<Response> {
		const { projectId, userId, role } = (await request.json()) as {
			projectId: string;
			userId: string;
			role: string;
		};

		if (!projectId || !userId || !role) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}

		if (role !== 'admin' && role !== 'member') {
			return this.jsonResponse(
				{ error: 'invalid_role', message: 'Role must be admin or member' },
				400,
			);
		}

		// Check that target user is not the owner
		const memberRows = this.sql
			.exec(
				'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
				projectId,
				userId,
			)
			.toArray();

		if (memberRows.length === 0) {
			return this.jsonResponse(
				{ error: 'not_found', message: 'User is not a member of this project' },
				404,
			);
		}

		if (memberRows[0].role === 'owner') {
			return this.jsonResponse(
				{ error: 'cannot_modify_owner', message: 'Cannot change the owner role' },
				400,
			);
		}

		this.sql.exec(
			'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?',
			role,
			projectId,
			userId,
		);

		// Fetch updated member with user info
		const rows = this.sql
			.exec(
				`SELECT pm.user_id, pm.role, pm.created_at, u.email, u.name
				FROM project_members pm
				JOIN users u ON pm.user_id = u.id
				WHERE pm.project_id = ? AND pm.user_id = ?`,
				projectId,
				userId,
			)
			.toArray();

		const row = rows[0];
		const member: ProjectMember = {
			userId: row.user_id as string,
			email: row.email as string,
			name: row.name as string,
			role: row.role as 'admin' | 'member',
			createdAt: row.created_at as string,
		};

		return this.jsonResponse({ member });
	}

	private handleGetSettings(_request: Request): Response {
		const registrationOpen = this.getSetting('registration_open') !== 'false';
		return this.jsonResponse({ settings: { registrationOpen } });
	}

	private async handleSetSettings(request: Request): Promise<Response> {
		const { requestingUserRole, registrationOpen } = (await request.json()) as {
			requestingUserRole?: string;
			registrationOpen?: boolean;
		};
		if (requestingUserRole !== 'admin') {
			return this.jsonResponse({ error: 'forbidden', message: 'Admin role required' }, 403);
		}
		if (typeof registrationOpen === 'boolean') {
			this.setSetting('registration_open', registrationOpen ? 'true' : 'false');
		}
		const open = this.getSetting('registration_open') !== 'false';
		return this.jsonResponse({ settings: { registrationOpen: open } });
	}

	private async handleWebauthnRegisterOptions(request: Request): Promise<Response> {
		const { userId, origin, rpID } = (await request.json()) as {
			userId?: string;
			origin?: string;
			rpID?: string;
		};
		if (!userId || !origin || !rpID) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'userId, origin, and rpID are required' },
				400,
			);
		}
		const userRows = this.sql
			.exec('SELECT id, email, name, disabled, webauthn_user_id FROM users WHERE id = ?', userId)
			.toArray();
		if (userRows.length === 0) {
			return this.jsonResponse({ error: 'user_not_found' }, 404);
		}
		if ((userRows[0].disabled as number) === 1) {
			return this.jsonResponse({ error: 'user_disabled' }, 403);
		}

		const webauthnUserId = this.ensureWebauthnUserId(
			userId,
			userRows[0].webauthn_user_id as string | null,
		);

		const existing = this.sql
			.exec('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?', userId)
			.toArray();
		const excludeCredentials = existing.map((row) => ({
			id: row.id as string,
			transports: parseTransports(row.transports),
		}));

		const options = await generateRegistrationOptions({
			rpName: 'Workers Sentinel',
			rpID,
			userName: userRows[0].email as string,
			userID: base64urlToBytes(webauthnUserId),
			userDisplayName: userRows[0].name as string,
			attestationType: 'none',
			authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
			excludeCredentials,
		});

		const ceremonyId = this.storeChallenge('register', userId, options.challenge, origin, rpID);
		return this.jsonResponse({ options, ceremonyId });
	}

	private async handleWebauthnRegisterVerify(request: Request): Promise<Response> {
		const { userId, ceremonyId, name, response, origin, rpID } = (await request.json()) as {
			userId?: string;
			ceremonyId?: string;
			name?: string;
			response?: RegistrationResponseJSON;
			origin?: string;
			rpID?: string;
		};
		if (!userId || !origin || !rpID) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'userId, origin, and rpID are required' },
				400,
			);
		}

		// Claim the ceremony synchronously FIRST: once the body carries a
		// parseable ceremonyId, the challenge row is consumed before any other
		// validation, so every identified attempt (blank name, malformed
		// payload, failed verification alike) burns it.
		const claim =
			typeof ceremonyId === 'string' && ceremonyId.length > 0
				? this.claimCeremony(ceremonyId, 'register', userId, origin, rpID)
				: null;
		if (!claim) {
			return this.jsonResponse(
				{ error: 'ceremony_invalid', message: 'Unknown, expired, or mismatched ceremony' },
				400,
			);
		}

		const trimmedName = typeof name === 'string' ? name.trim() : '';
		if (!trimmedName) {
			return this.jsonResponse(
				{ error: 'name_required', message: 'A name for the passkey is required' },
				400,
			);
		}
		if (trimmedName.length > 100) {
			return this.jsonResponse(
				{ error: 'invalid_name', message: 'Name must be at most 100 characters' },
				400,
			);
		}

		const userRows = this.sql.exec('SELECT id, disabled FROM users WHERE id = ?', userId).toArray();
		if (userRows.length === 0 || (userRows[0].disabled as number) === 1) {
			return this.jsonResponse({ error: 'user_disabled' }, 403);
		}

		if (!response || typeof response !== 'object') {
			return this.jsonResponse(
				{ error: 'verification_failed', message: 'Missing registration response' },
				400,
			);
		}

		let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
		try {
			verification = await verifyRegistrationResponse({
				response,
				expectedChallenge: claim.challenge,
				expectedOrigin: claim.origin,
				expectedRPID: claim.rpID,
				requireUserVerification: false,
			});
		} catch (error) {
			return this.jsonResponse(
				{
					error: 'verification_failed',
					message: error instanceof Error ? error.message : 'Registration verification failed',
				},
				400,
			);
		}
		if (!verification.verified || !verification.registrationInfo) {
			return this.jsonResponse(
				{ error: 'verification_failed', message: 'Registration verification failed' },
				400,
			);
		}

		const { credential, aaguid, credentialDeviceType, credentialBackedUp } =
			verification.registrationInfo;

		const duplicate = this.sql
			.exec('SELECT 1 FROM webauthn_credentials WHERE id = ?', credential.id)
			.toArray();
		if (duplicate.length > 0) {
			return this.jsonResponse(
				{ error: 'credential_exists', message: 'This passkey is already registered' },
				409,
			);
		}

		const now = new Date().toISOString();
		this.sql.exec(
			`INSERT INTO webauthn_credentials
			 (id, user_id, name, public_key, counter, transports, aaguid, backup_eligible, backed_up, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			credential.id,
			userId,
			trimmedName,
			toArrayBuffer(credential.publicKey),
			credential.counter,
			credential.transports ? JSON.stringify(credential.transports) : null,
			aaguid,
			credentialDeviceType === 'multiDevice' ? 1 : 0,
			credentialBackedUp ? 1 : 0,
			now,
		);

		const stored: WebauthnCredentialInfo = {
			id: credential.id,
			name: trimmedName,
			createdAt: now,
			lastUsedAt: null,
		};
		return this.jsonResponse({ credential: stored });
	}

	private async handleWebauthnLoginOptions(request: Request): Promise<Response> {
		const { email, origin, rpID } = (await request.json()) as {
			email?: string;
			origin?: string;
			rpID?: string;
		};
		if (!origin || !rpID) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'origin and rpID are required' },
				400,
			);
		}

		// Optional email hint: when it names a live, enabled user the
		// challenge is user-bound (verify then only accepts that user's
		// credentials). Credential IDs are never echoed to this public
		// endpoint — the challenge is always discoverable-shaped so the
		// response cannot reveal account existence, enabledness, or
		// passkey adoption. Residual, accepted: a caller who already holds
		// a valid passkey can still distinguish a bound (401) from an
		// unbound (200) verify; see AGENTS.md.
		let boundUserId: string | null = null;
		if (email && typeof email === 'string') {
			const rows = this.sql
				.exec('SELECT id, disabled FROM users WHERE email = ?', email.trim().toLowerCase())
				.toArray();
			if (rows.length > 0 && (rows[0].disabled as number) === 0) {
				boundUserId = rows[0].id as string;
			}
		}

		const options = await generateAuthenticationOptions({
			rpID,
			userVerification: 'preferred',
		});

		const ceremonyId = this.storeChallenge('login', boundUserId, options.challenge, origin, rpID);
		return this.jsonResponse({ options, ceremonyId });
	}

	private async handleWebauthnLoginVerify(request: Request): Promise<Response> {
		const { ceremonyId, response, origin, rpID } = (await request.json()) as {
			ceremonyId?: string;
			response?: AuthenticationResponseJSON;
			origin?: string;
			rpID?: string;
		};
		if (!origin || !rpID) {
			return this.jsonResponse(
				{ error: 'missing_fields', message: 'origin and rpID are required' },
				400,
			);
		}

		// Claim the ceremony FIRST (kind/origin/rpID must match the stored
		// row; user binding is checked once the credential resolves).
		const claim =
			typeof ceremonyId === 'string' && ceremonyId.length > 0
				? this.claimCeremony(ceremonyId, 'login', null, origin, rpID)
				: null;
		if (!claim) {
			return this.jsonResponse(
				{ error: 'ceremony_invalid', message: 'Unknown, expired, or mismatched ceremony' },
				400,
			);
		}

		// Unknown credential id consumes the ceremony and fails uniformly
		if (!response || typeof response.id !== 'string' || !response.id) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}
		const credRows = this.sql
			.exec(
				`SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE id = ?`,
				response.id,
			)
			.toArray();
		if (credRows.length === 0) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}
		const credentialRow = credRows[0];

		// A user-bound (email-hinted) ceremony only accepts that user's credentials
		if (claim.userId !== null && claim.userId !== credentialRow.user_id) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}

		const userRows = this.sql
			.exec(
				'SELECT id, email, name, role, disabled, created_at, updated_at FROM users WHERE id = ?',
				credentialRow.user_id,
			)
			.toArray();
		// Uniform 401 for missing and disabled accounts (no disable oracle)
		if (userRows.length === 0 || (userRows[0].disabled as number) === 1) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}

		let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
		try {
			verification = await verifyAuthenticationResponse({
				response,
				expectedChallenge: claim.challenge,
				expectedOrigin: claim.origin,
				expectedRPID: claim.rpID,
				requireUserVerification: false,
				credential: {
					id: credentialRow.id as string,
					publicKey: blobToBytes(credentialRow.public_key as ArrayBuffer | Uint8Array),
					counter: credentialRow.counter as number,
					transports: parseTransports(credentialRow.transports),
				},
			});
		} catch {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}
		if (!verification.verified) {
			return this.jsonResponse({ error: 'invalid_credentials' }, 401);
		}

		const now = new Date().toISOString();
		this.sql.exec(
			'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
			verification.authenticationInfo.newCounter,
			now,
			credentialRow.id as string,
		);

		// Mint a session via the same path as password login (same 20-session cap)
		const session = await this.createSession(userRows[0].id as string);

		const user: User = {
			id: userRows[0].id as string,
			email: userRows[0].email as string,
			name: userRows[0].name as string,
			role: userRows[0].role as 'admin' | 'member',
			createdAt: userRows[0].created_at as string,
			updatedAt: userRows[0].updated_at as string,
		};

		return this.jsonResponse({ user, token: session.id, hasPasskey: true });
	}

	private async handleWebauthnListCredentials(request: Request): Promise<Response> {
		const { userId } = (await request.json()) as { userId?: string };
		if (!userId) {
			return this.jsonResponse({ error: 'missing_user_id' }, 400);
		}
		const rows = this.sql
			.exec(
				'SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC',
				userId,
			)
			.toArray();
		const credentials: WebauthnCredentialInfo[] = rows.map((row) => ({
			id: row.id as string,
			name: row.name as string,
			createdAt: row.created_at as string,
			lastUsedAt: (row.last_used_at as string | null) ?? null,
		}));
		return this.jsonResponse({ credentials });
	}

	private async handleWebauthnDeleteCredential(request: Request): Promise<Response> {
		const { userId, credentialId } = (await request.json()) as {
			userId?: string;
			credentialId?: string;
		};
		if (!userId || !credentialId) {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}
		// Delete only when owned by the caller (uniform 404 otherwise).
		// Deleting the last passkey is allowed: password login remains.
		const owned = this.sql
			.exec(
				'SELECT id FROM webauthn_credentials WHERE id = ? AND user_id = ?',
				credentialId,
				userId,
			)
			.toArray();
		if (owned.length === 0) {
			return this.jsonResponse({ error: 'not_found' }, 404);
		}
		this.sql.exec('DELETE FROM webauthn_credentials WHERE id = ?', credentialId);
		return this.jsonResponse({ success: true });
	}

	// Test-only ceremony hooks (inert unless WEBAUTHN_TEST_HOOKS=enabled)

	private async handleWebauthnTestBackdate(request: Request): Promise<Response> {
		if (this.env.WEBAUTHN_TEST_HOOKS !== 'enabled') {
			return this.jsonResponse({ error: 'not_found' }, 404);
		}
		const { ceremonyId, ageMs } = (await request.json()) as {
			ceremonyId?: string;
			ageMs?: number;
		};
		if (!ceremonyId || typeof ageMs !== 'number') {
			return this.jsonResponse({ error: 'missing_fields' }, 400);
		}
		this.sql.exec(
			'UPDATE webauthn_challenges SET created_at = ? WHERE ceremony_id = ?',
			new Date(Date.now() - ageMs).toISOString(),
			ceremonyId,
		);
		return this.jsonResponse({ success: true });
	}

	private handleWebauthnTestChallengeCount(): Response {
		if (this.env.WEBAUTHN_TEST_HOOKS !== 'enabled') {
			return this.jsonResponse({ error: 'not_found' }, 404);
		}
		const row = this.sql.exec('SELECT COUNT(*) AS count FROM webauthn_challenges').one();
		return this.jsonResponse({ count: (row?.count as number) ?? 0 });
	}

	private async handleListUsers(request: Request): Promise<Response> {
		const { requestingUserRole } = (await request.json()) as {
			requestingUserRole: string;
		};

		if (requestingUserRole !== 'admin') {
			return this.jsonResponse({ error: 'forbidden', message: 'Only admins can list users' }, 403);
		}

		const rows = this.sql
			.exec('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC')
			.toArray();

		const users = rows.map((row) => ({
			id: row.id as string,
			email: row.email as string,
			name: row.name as string,
			role: row.role as string,
			createdAt: row.created_at as string,
		}));

		return this.jsonResponse({ users });
	}

	private async createSession(userId: string): Promise<Session> {
		const sessionToken = this.generateKey(64);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

		// Store only the hash of the session token; the raw token is returned
		// to the client exactly once and never persisted
		this.sql.exec(
			'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
			hashToken(sessionToken),
			userId,
			expiresAt.toISOString(),
			now.toISOString(),
		);

		// Prune: keep at most 20 concurrent sessions per user (oldest dropped)
		this.sql.exec(
			'DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20)',
			userId,
			userId,
		);

		return {
			id: sessionToken,
			userId,
			expiresAt: expiresAt.toISOString(),
			createdAt: now.toISOString(),
		};
	}

	private async cleanExpiredSessions(): Promise<void> {
		this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
	}

	/** Whether the user has at least one registered passkey. */
	private hasPasskey(userId: string): boolean {
		const row = this.sql
			.exec('SELECT EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id = ?) AS has', userId)
			.one();
		return (row?.has as number) === 1;
	}

	/**
	 * The stable opaque WebAuthn user handle (32 random bytes, base64url).
	 * Minted lazily on first registration; never the email, ≤64 bytes per spec.
	 */
	private ensureWebauthnUserId(userId: string, existing: string | null): string {
		if (existing) return existing;
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		const handle = bytesToBase64url(bytes);
		this.sql.exec('UPDATE users SET webauthn_user_id = ? WHERE id = ?', handle, userId);
		return handle;
	}

	/**
	 * Store a ceremony challenge. Every issuance first sweeps expired rows,
	 * then enforces bounded outstanding sets: at most 10 unexpired per
	 * (kind, user) bucket and 500 unexpired total, evicting oldest-first
	 * within the bucket so the table never grows beyond bounds.
	 */
	private storeChallenge(
		kind: 'register' | 'login',
		userId: string | null,
		challenge: string,
		origin: string,
		rpID: string,
	): string {
		const nowIso = new Date().toISOString();
		const cutoff = new Date(Date.now() - WEBAUTHN_CHALLENGE_TTL_MS).toISOString();
		this.sql.exec('DELETE FROM webauthn_challenges WHERE created_at < ?', cutoff);

		const total =
			(this.sql.exec('SELECT COUNT(*) AS count FROM webauthn_challenges').one()?.count as number) ??
			0;
		if (total >= WEBAUTHN_MAX_TOTAL_CHALLENGES) {
			this.sql.exec(
				`DELETE FROM webauthn_challenges WHERE ceremony_id IN (
					SELECT ceremony_id FROM webauthn_challenges
					ORDER BY created_at ASC, ceremony_id ASC LIMIT ?
				)`,
				total - WEBAUTHN_MAX_TOTAL_CHALLENGES + 1,
			);
		}

		const bucket =
			(this.sql
				.exec(
					'SELECT COUNT(*) AS count FROM webauthn_challenges WHERE kind = ? AND user_id IS ?',
					kind,
					userId,
				)
				.one()?.count as number) ?? 0;
		if (bucket >= WEBAUTHN_MAX_CHALLENGES_PER_BUCKET) {
			this.sql.exec(
				`DELETE FROM webauthn_challenges WHERE ceremony_id IN (
					SELECT ceremony_id FROM webauthn_challenges
					WHERE kind = ? AND user_id IS ?
					ORDER BY created_at ASC, ceremony_id ASC LIMIT ?
				)`,
				kind,
				userId,
				bucket - WEBAUTHN_MAX_CHALLENGES_PER_BUCKET + 1,
			);
		}

		const ceremonyId = crypto.randomUUID();
		this.sql.exec(
			'INSERT INTO webauthn_challenges (ceremony_id, kind, user_id, challenge, origin, rp_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			ceremonyId,
			kind,
			userId,
			challenge,
			origin,
			rpID,
			nowIso,
		);
		return ceremonyId;
	}

	/**
	 * Atomically claim a ceremony: select the matching unexpired row (kind,
	 * origin, rpID, and — for register — the bound user) and delete it before
	 * any other validation runs. DO input gates make this select-then-delete
	 * atomic within a single handler. Returns the claimed challenge, or null.
	 */
	private claimCeremony(
		ceremonyId: string,
		kind: 'register' | 'login',
		userId: string | null,
		origin: string,
		rpID: string,
	): { challenge: string; userId: string | null; origin: string; rpID: string } | null {
		const cutoff = new Date(Date.now() - WEBAUTHN_CHALLENGE_TTL_MS).toISOString();
		const rows = this.sql
			.exec(
				'SELECT challenge, user_id, origin, rp_id FROM webauthn_challenges WHERE ceremony_id = ? AND kind = ? AND origin = ? AND rp_id = ? AND created_at >= ?',
				ceremonyId,
				kind,
				origin,
				rpID,
				cutoff,
			)
			.toArray();
		if (rows.length === 0) return null;
		const rowUserId = rows[0].user_id as string | null;
		if (kind === 'register' && rowUserId !== userId) return null;
		this.sql.exec('DELETE FROM webauthn_challenges WHERE ceremony_id = ?', ceremonyId);
		return {
			challenge: rows[0].challenge as string,
			userId: rowUserId,
			// Return the row's pinned values (equal to the request's by the
			// match above) so verification always uses what was issued.
			origin: rows[0].origin as string,
			rpID: rows[0].rp_id as string,
		};
	}

	private generateKey(length: number): string {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return Array.from(array)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, length);
	}

	private slugify(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 50);
	}

	private jsonResponse(data: unknown, status = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}
