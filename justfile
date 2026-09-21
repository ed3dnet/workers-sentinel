# Human-facing local development tasks; local-only (Cloudflare credentials are
# stripped from all supervisor children; no remote commands exist here).
set shell := ["bash", "-cu"]

default:
    @just --list

# Install workspace dependencies and git hooks; never starts anything.
install:
    pnpm install
    lefthook install

# Build dashboard then worker packages (wrangler dev also runs the dashboard build itself).
build:
    pnpm build

# Foreground guarded local supervisor: wrangler dev under Workerd, loopback-only,
# repo-owned Durable Object state. Stop with `just dev-down` from another terminal.
dev-up:
    node _devenv/cloudflare/commands.mjs up dev

# Authenticated live supervisor stop; never signals recorded PIDs.
dev-down:
    node _devenv/cloudflare/commands.mjs down dev

# Remove only repo-owned local state; requires --confirm-local-reset.
dev-reset confirmation:
    node _devenv/cloudflare/commands.mjs reset dev {{quote(confirmation)}}

# HTTP smoke (health + dashboard assets) against a running supervisor.
smoke:
    node _devenv/cloudflare/commands.mjs smoke dev

# Seed a demo user/project/events against a running supervisor.
send-demo-events:
    node _devenv/cloudflare/demo.mjs

# Worker test suite (vitest-pool-workers, no supervisor needed).
test:
    pnpm --dir packages/workers-sentinel test

# Worker WebAuthn env-variant suite (WEBAUTHN_ORIGINS allowlist path).
test-webauthn-origins:
    pnpm --dir packages/workers-sentinel test:webauthn-origins

# Dashboard component suite (vitest + happy-dom + @vue/test-utils).
test-dashboard:
    pnpm --dir packages/dashboard test

# Black-box integration suite; boots its own wrangler dev (own port/state).
test-integration:
    node scripts/integration.mjs

typecheck:
    pnpm typecheck

lint:
    pnpm lint

lint-fix:
    pnpm lint:fix
