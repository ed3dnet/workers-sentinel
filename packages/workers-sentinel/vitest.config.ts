import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
	test: {
		// integration/** is the black-box node:test suite run by
		// scripts/integration.mjs against a live wrangler instance, not the
		// in-isolate vitest suite; webauthn-origins.test.ts only runs under
		// vitest.webauthn-origins.config.ts (its own env binding variant)
		exclude: [
			...configDefaults.exclude,
			'integration/**',
			'test/webauthn-origins.test.ts',
			'test/webauthn-management.test.ts',
		],
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				main: './test/entry.ts',
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						SETUP_TOKEN: 'test-setup-token',
						// Test-only fault-injection switch: enables the
						// X-Sentinel-Test-Fault header and internal fault
						// markers. Never bound in wrangler.jsonc, so the
						// mechanism is inert in dev/prod/integration runs.
						ATTACHMENT_FAULT_INJECTION: 'enabled',
						// Test-only WebAuthn hooks (backdate ceremonies,
						// inspect the challenge table). Same inertness rule.
						WEBAUTHN_TEST_HOOKS: 'enabled',
					},
				},
			},
		},
	},
});
