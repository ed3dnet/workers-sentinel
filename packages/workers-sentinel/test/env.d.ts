import type { Env as SrcEnv } from '../src/types';

// The @cloudflare/vitest-plugin types `env` as `Cloudflare.Env` (the shape
// `wrangler types` generates). This project keeps a hand-maintained Env in
// src/types.ts (with documentation and optional test-only vars), so merge
// it into the global Cloudflare namespace for the test files.
declare global {
	namespace Cloudflare {
		// biome-ignore lint/suspicious/noExplicitAny: placeholder to satisfy declaration-merging lint
		interface Env extends SrcEnv {}
	}
}
