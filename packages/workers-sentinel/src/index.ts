import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { adminRoutes } from './routes/admin';
import { api0ErrorTranslator, api0Routes } from './routes/api0';
import { attachmentRoutes } from './routes/attachments';
import { authRoutes, tokenRoutes } from './routes/auth';
import { eventRoutes } from './routes/events';
import { filterRoutes } from './routes/filters';
import { ingestionRoutes } from './routes/ingestion';
import { issueRoutes } from './routes/issues';
import { memberRoutes } from './routes/members';
import { projectRoutes } from './routes/projects';
import { releaseRoutes } from './routes/releases';
import { sourcemapRoutes } from './routes/sourcemaps';
import { webauthnRoutes } from './routes/webauthn';
import type { AuthContext, Env } from './types';

// Re-export Durable Objects
export { AuthState } from './durable-objects/auth-state';
export { ProjectState } from './durable-objects/project-state';

// Re-export RPC entrypoint for service bindings
export { SentinelRpc } from './rpc';

type Variables = {
	auth?: AuthContext;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS for the dashboard/API surface: the SPA is served same-origin by this
// worker, so cross-origin access is only granted to explicitly configured
// origins (CORS_ORIGINS, comma-separated). Never combines wildcard origins
// with credentials.
app.use('/api/*', async (c, next) => {
	const origin = c.req.header('Origin');
	const allowlist = (c.env.CORS_ORIGINS ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	const allowed = origin && allowlist.includes(origin) ? origin : null;
	if (allowed) {
		c.header('Access-Control-Allow-Origin', allowed);
		c.header('Access-Control-Allow-Credentials', 'true');
		c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
		c.header('Vary', 'Origin');
	}
	// SDK ingestion paths handle their own permissive preflight; everything
	// else answers preflight with a bare 204 and no CORS grant.
	const isSdkPath = /^\/api\/[^/]+\/(envelope|store|security)\/?$/.test(c.req.path);
	if (c.req.method === 'OPTIONS' && !isSdkPath) {
		return c.body(null, 204);
	}
	await next();
	return;
});

// Security headers for every response (API and dashboard assets alike)
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.use('*', async (c, next) => {
	await next();
	const headers = new Headers(c.res.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	const contentType = headers.get('Content-Type') ?? '';
	if (contentType.includes('text/html')) {
		headers.set('Content-Security-Policy', CSP);
	}
	c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	return;
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Public routes (no auth required)
app.route('/api/auth', authRoutes);

// API token management routes (session auth required)
app.use('/api/auth/tokens/*', authMiddleware);
app.use('/api/auth/tokens', authMiddleware);
app.route('/api/auth/tokens', tokenRoutes);

// Passkey (WebAuthn) routes. Login ceremonies are public; register and
// credential management are session-only (the manage router itself rejects
// `wst_` API tokens with 403 session_required — AuthContext.session is
// synthesized for API tokens, so the raw token prefix is the discriminator).
app.use('/api/auth/webauthn/register/*', authMiddleware);
app.use('/api/auth/webauthn/verify/register', authMiddleware);
app.use('/api/auth/webauthn/credentials/*', authMiddleware);
app.use('/api/auth/webauthn/credentials', authMiddleware);
app.route('/api/auth/webauthn', webauthnRoutes);

// Ingestion routes (DSN auth, not session auth)
app.route('/api', ingestionRoutes);

// Protected routes (session auth required)
app.use('/api/projects/*', authMiddleware);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', memberRoutes);
app.route('/api/projects', issueRoutes);
app.route('/api/projects', eventRoutes);
app.route('/api/projects', attachmentRoutes);
app.route('/api/projects', releaseRoutes);
app.route('/api/projects', sourcemapRoutes);
app.route('/api/projects', filterRoutes);

// Admin routes (session auth required)
app.use('/api/admin/*', authMiddleware);
app.route('/api/admin', adminRoutes);

// Sentry /api/0 API (agentic triage + event-attachment surface). The
// error-shape translator is registered BEFORE authMiddleware: registration
// order is wrap order in Hono, so the translator's `await next()` wraps
// auth's early 401 returns and rewrites them to {"detail": …}. Auth still
// runs before route matching, preserving the /api/projects/* precedence
// (anonymous probes of unknown /api/0 paths answer 401, not 404).
app.use('/api/0/*', api0ErrorTranslator);
app.use('/api/0/*', authMiddleware);
app.route('/api/0', api0Routes);

// Unknown /api/* GETs must not fall through to the SPA: API clients get a
// JSON 404 instead of the dashboard's HTML (served with a 200). Auth runs
// first on protected namespaces, so anonymous probes of unknown protected
// paths still answer 401, not 404.
app.get('*', (c) => {
	if (c.req.path.startsWith('/api/')) {
		return c.json({ error: 'not_found' }, 404);
	}
	// Assets binding handles static files
	return c.env.ASSETS?.fetch(c.req.raw) ?? c.text('Dashboard not found', 404);
});

// Same contract for unmatched non-GET /api/* methods (e.g. POST /api/nope)
app.notFound((c) => {
	if (c.req.path.startsWith('/api/')) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.text('Not Found', 404);
});

export default app;

export function workersSentinel() {
	return app;
}
