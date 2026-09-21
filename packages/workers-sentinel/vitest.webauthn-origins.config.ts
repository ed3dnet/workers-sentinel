import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Env variant of the worker suite: binds WEBAUTHN_ORIGINS so the allowlist
// path of the trusted-origin policy is exercised (mirrors dev with the vite
// proxy at http://localhost:5173). Run via `pnpm test:webauthn-origins`.
export default defineWorkersConfig({
	test: {
		include: ['test/webauthn-origins.test.ts'],
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				main: './test/entry.ts',
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						SETUP_TOKEN: 'test-setup-token',
						WEBAUTHN_ORIGINS: 'http://localhost:5173',
						WEBAUTHN_TEST_HOOKS: 'enabled',
					},
				},
			},
		},
	},
});
