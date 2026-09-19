# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` points here for Claude Code compatibility.

## Project Overview

Workers Sentinel is a self-hosted, Sentry-compatible error tracking system running entirely on Cloudflare Workers. It accepts events from Sentry SDKs via the envelope protocol and stores them in SQLite-backed Durable Objects.

## Commands

```bash
# Development - runs worker with wrangler dev
pnpm dev

# Build dashboard then worker
pnpm build

# Deploy to Cloudflare
pnpm deploy

# Lint with Biome
pnpm lint
pnpm lint:fix

# Format
pnpm format

# Typecheck all packages
pnpm typecheck

# Dashboard-specific
pnpm --filter @workers-sentinel/dashboard dev      # Vite dev server
pnpm --filter @workers-sentinel/dashboard build    # Production build

# Worker-specific
pnpm --filter @workers-sentinel/worker dev         # Wrangler dev
pnpm --filter @workers-sentinel/worker test        # Run tests once
pnpm --filter @workers-sentinel/worker test:watch  # Run tests in watch mode
pnpm --filter @workers-sentinel/worker typecheck   # TypeScript check
```

## Architecture

### Monorepo Structure

- `packages/workers-sentinel/` - Cloudflare Worker (Hono framework)
- `packages/dashboard/` - Vue.js 3 frontend (served as static assets)

### Durable Objects

Two SQLite-backed Durable Objects handle all state:

**AuthState** (singleton, named "global"):
- `users`, `sessions`, `projects`, `project_members` tables
- Handles registration, login, session validation, project registry
- All requests go through `http://internal/*` fetch pattern

**ProjectState** (per-project, named by project ID):
- `issues`, `events`, `issue_stats`, `issue_users` tables
- Handles event ingestion, issue grouping, statistics
- Each project has isolated storage

### Request Flow

```
Sentry SDK → /api/{projectId}/envelope/ → DSN validation (AuthState)
           → Parse envelope → Fingerprint → Store (ProjectState)

Dashboard  → /api/auth/* (public) → AuthState
           → /api/projects/* (protected) → authMiddleware → ProjectState
```

### Key Modules

- `lib/envelope-parser.ts` - Parses Sentry envelope format (newline-delimited JSON)
- `lib/fingerprint.ts` - Groups events into issues using exception type + message + stack frames
- `routes/ingestion.ts` - SDK endpoint, supports `?sentry_key=` and `X-Sentry-Auth` header

### DSN Format

```
https://{publicKey}@{host}/{projectId}
```

The publicKey is validated against AuthState's projects table. ProjectState is accessed by project ID.

### Service Bindings

Cloudflare Workers can send events via service binding instead of HTTP for lower latency. The ingestion endpoint works identically - service bindings only change transport, not authentication. See README for custom transport setup.

## Polytoken harness sessions

Long-lived processes run as **shell services**, not background shell jobs (background jobs are reaped between turns). The local stack is a single foreground supervisor, so one service holds it:

- **Start**: `shell_service` with name `sentinel-dev` (if that name is already terminal from a prior run, start the replacement under a new name such as `sentinel-dev2` — `restart` on an already-exited service errors), command `exec just dev-up`, health check `curl -sf http://127.0.0.1:25304/api/health >/dev/null` (5s interval), `copy_url: http://127.0.0.1:25304`, and `notification_match: 'Ready:'` so readiness wakes the session.
- **Readiness**: wait for the `ServiceHealthCheckPassed` notification or the supervisor's `Ready:` log line. The first start builds the dashboard (up to ~2 min budget); later starts are warm and ready in seconds. Read logs with `job_status` on the service's job id.
- **Stop**: run `just dev-down` via `shell_exec` from any shell — it performs the authenticated loopback stop and cleans the ownership records (`inventory.json`, `lock/`, `control.json`). Never kill a recorded PID. A SIGTERM delivered to the supervisor process itself also triggers its clean stop handler.
- **Stale state**: if `dev-up` refuses because `inventory.json` or `lock/` remain after an unclean end, reconcile manually (confirm nothing listens on the port, then delete those records) before starting a new service — do not script around the guard.
- **One-off commands** (`just smoke`, `just send-demo-events`, `just test`, `just lint`) are plain `shell_exec` calls; they talk to the running service over loopback and don't need Polytoken management of their own.

## Local development stack (guarded supervisor)

A scaled-down port of the ed3dsite-2025 `_devenv/cloudflare` pattern lives in `_devenv/cloudflare/`. It runs the whole stack locally under Workerd (`wrangler dev`) with no Cloudflare credentials: child processes are spawned with `CLOUDFLARE_*`/`CF_*`/`WRANGLER_*`/`DOCKER_*` variables stripped, so the supervisor is local-only by construction. Remote deployment is deliberately not a command here (pinned for later; it would use wrangler's own interactive login, never shared secrets machinery).

```bash
just install            # pnpm install across the workspace
just dev-up             # foreground supervisor: builds dashboard via wrangler's build.command, waits for /api/health
just dev-down           # authenticated stop via loopback control endpoint (from another terminal)
just dev-reset --confirm-local-reset  # remove repo-owned local state (refuses while an inventory record exists)
just smoke              # GET /api/health + / against a running supervisor
just send-demo-events   # seed demo user/project/events (Sentry envelopes) against a running supervisor
just test               # worker test suite (vitest-pool-workers; no supervisor needed)
```

- State lives in `_devenv/cloudflare/.state/dev/` (gitignored): `persist/` (Durable Object SQLite state, survives restarts), plus ephemeral `inventory.json`, `lock/`, `control.json` ownership records that are removed only on clean stop.
- Port is deterministic per checkout path (this checkout: 25304); override with `SENTINEL_LOCAL_PORT`. Binding is `127.0.0.1` only.
- `dev-down` never signals recorded PIDs. If `dev-up` refuses due to a stale inventory/lock (e.g. after a crash), reconcile manually: confirm nothing listens on the port, then delete `inventory.json` and `lock/` yourself — never `kill` a recorded PID.
- Demo credentials: `demo@sentinel.local` / `sentinel-demo-password` (project `CLI Feedback`).

## Technology Stack

- **Worker**: Hono, Cloudflare Workers, Durable Objects with SQLite
- **Dashboard**: Vue 3, Pinia, Vue Router, Tailwind CSS, Vite
- **Tooling**: pnpm workspaces, Biome (lint/format), TypeScript

## Testing

Tests use `@cloudflare/vitest-pool-workers` with `isolatedStorage: false` and `singleWorker: true` for state persistence across tests within a describe block. DO operations may fail with "invalidating this Durable Object" error during test restarts—test utilities include retry logic for this.

## Code Style

Biome enforces: tabs for indentation, single quotes, semicolons required, 100 character line width.
