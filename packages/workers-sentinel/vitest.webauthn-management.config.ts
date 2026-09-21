import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Env variant of the worker suite: credential-deletion coverage runs in its
// own worker process. Under singleWorker + isolatedStorage:false, exercising
// the credential-delete flow from the shared main-suite worker triggers a
// progressive isolate-wide transport slowdown in the runner (reproduced
// across URL-param and body-based delete shapes; every configuration without
// these calls is green, including main). Run via `pnpm test:webauthn-management`.
export default defineWorkersConfig({
	test: {
		include: ['test/webauthn-management.test.ts'],
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				main: './test/entry.ts',
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						SETUP_TOKEN: 'test-setup-token',
					},
				},
			},
		},
	},
});
