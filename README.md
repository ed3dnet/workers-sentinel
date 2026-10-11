<div align="center">
  <a href="#">
    <h1 style="font-size: 4rem;">🛡️</h1>
    <h1>Workers Sentinel</h1>
  </a>
</div>

<p align="center">
    <em>A self-hosted error tracking system with Sentry SDK ingestion compatibility, running entirely on Cloudflare Workers</em>
</p>

<p align="center">
    <a href="https://github.com/G4brym/workers-sentinel/commits/main" target="_blank">
      <img src="https://img.shields.io/github/commit-activity/m/G4brym/workers-sentinel?label=Commits&style=social" alt="Workers Sentinel Commits">
    </a>
    <a href="https://github.com/G4brym/workers-sentinel/issues" target="_blank">
      <img src="https://img.shields.io/github/issues/G4brym/workers-sentinel?style=social" alt="Issues">
    </a>
    <a href="https://github.com/G4brym/workers-sentinel/blob/main/LICENSE" target="_blank">
      <img src="https://img.shields.io/badge/license-MIT-brightgreen.svg?style=social" alt="Software License">
    </a>
</p>

# Workers Sentinel

> **⚠️ Disclaimer:** This is a toy project and a very poor imitation of Sentry. It doesn't even represent 0.1% of all Sentry features. This should not be taken seriously or used in any production environment where you actually care about error tracking. Please use the real [Sentry](https://sentry.io) for production workloads.

Workers Sentinel is a lightweight, self-hosted error tracking and monitoring solution that runs entirely on your Cloudflare account. It accepts events using the Sentry SDK wire format, allowing you to use existing Sentry SDKs by simply changing the DSN endpoint. All your error data is stored securely in SQLite-backed Durable Objects, giving you full control over your information.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/G4brym/workers-sentinel/tree/main/template)

## Table of Contents

- [Overview](#overview)
- [Why Workers Sentinel?](#why-workers-sentinel)
- [Key Features](#key-features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [SDK Configuration](#sdk-configuration)
- [Webhook Notifications](#webhook-notifications)
- [API Tokens](#api-tokens)
- [Architecture](#architecture)
- [Roadmap & Future Enhancements](#roadmap--future-enhancements)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Overview

Workers Sentinel gives you a private, self-hosted error tracking solution with a modern web dashboard. By leveraging the Cloudflare ecosystem, it offers a cost-effective and scalable alternative to hosted error tracking services. All your data is stored in your own Durable Objects with SQLite storage (and attachment payloads in your own R2 bucket), giving you complete control and privacy.

## Why Workers Sentinel?

**🔒 Privacy First**
- All data stays in YOUR Cloudflare account
- No third-party tracking or data sharing
- You control your error data completely

**💰 Cost-Effective**
- Runs on Cloudflare's generous free tier
- Pay only for what you use beyond free limits
- No monthly subscription fees

**⚡ Performance**
- Built on Cloudflare's global edge network
- Fast error ingestion worldwide
- Serverless architecture scales automatically

**🔌 SDK Compatible**
- Works with existing Sentry SDKs
- Just change your DSN endpoint
- Supports JavaScript, Python, Go, and more

**🎨 Modern Dashboard**
- Project overview with error trend charts and key metrics
- Clean, intuitive interface
- Stack trace visualization
- Issue grouping and management

**🛠️ Easy Setup**
- Deploy with one click
- Automatic project creation
- Smart authentication setup

## Key Features

- **🔌 Sentry SDK Compatible**: Use existing Sentry SDKs by changing only the DSN endpoint
- **🔒 Secure & Private**: Self-hosted on your Cloudflare account with no third-party data access
- **🔐 Smart Authentication**: Automatic first-user admin setup with session-based auth
- **🔑 Passkeys (WebAuthn)**: Register named passkeys and sign in usernameless with a fingerprint, face, or security key — no password needed; managed from the account Settings page
- **📊 Issue Grouping**: Automatic fingerprinting groups similar errors into issues
- **📈 Project Overview Dashboard**: At-a-glance error health with trend charts, metric cards, and top active issues
- **📈 Event Statistics**: Track error frequency with hourly aggregations
- **🔍 Stack Traces**: Full stack trace visualization with code context
- **👥 User Tracking**: See how many users are affected by each issue
- **🏷️ Tags & Context**: View tags, breadcrumbs, and contextual data
- **🔎 Tag-Based Filtering**: Search and filter issues by tag key-value pairs (e.g., browser, OS, environment)
- **✅ Issue Management**: Mark issues as resolved or ignored, or snooze them to revisit later
- **⏰ Issue Snooze**: Temporarily hide issues for a configurable duration (1h, 1d, 3d, 1w) with automatic un-snooze via Durable Object alarms
- **🌍 Environment Filtering**: View errors from specific environments (production, staging, development) separately
- **💬 Comments & Activity Timeline**: Post comments on issues and view a unified activity feed of comments and status changes
- **🌐 Multi-Project**: Create multiple projects with isolated data storage
- **👥 Team Management**: Add members to projects with role-based access control (owner/admin/member)
- **🔔 Webhook Notifications**: Get notified when new issues are detected via Slack, Discord, or any HTTP endpoint
- **⚡ Rate Limiting**: Configurable per-project event quotas to prevent runaway error loops from overwhelming the system
- **🗑️ Data Retention**: Configurable per-project retention policies with automatic cleanup
- **🗺️ Source Maps**: Upload source maps per release to resolve minified stack traces back to original source locations
- **📎 Attachments**: Store attachment payloads up to 21 MiB per envelope in Cloudflare R2 — binary supported, downloads with `Range` support, and a Sentry-compatible `/api/0` read surface for event attachments
- **🚫 Inbound Filters**: Drop noisy events before storage with server-side filters (message, exception type, IP address, release, environment)

## Prerequisites

Before deploying Workers Sentinel, make sure you have:

- **Cloudflare Account** - [Sign up for free](https://dash.cloudflare.com/sign-up)
- **Node.js 20+** - For local development (not required for one-click deployment)

**Cloudflare Services Used:**
- Workers (Compute)
- Durable Objects with SQLite (State management)
- R2 (Attachment payloads)
- Workers Assets (Dashboard hosting)

All these services have generous free tiers sufficient for most use cases.

## Getting Started

### One-Click Deploy

Use the "Deploy to Cloudflare" button above, or run:

```bash
npm create cloudflare@latest -- --template=https://github.com/G4brym/workers-sentinel/tree/main/template
```

### Manual Deployment

```bash
# Clone this deployment's source repository
git clone https://github.com/tilmon-engineering/workers-sentinel.git
cd workers-sentinel

# Install dependencies
pnpm install

# Build and deploy an already bootstrapped installation
CLOUDFLARE_ACCOUNT_ID=<zone-owning-account-id> pnpm deploy
```

This source configuration deploys `workers-sentinel` to the custom domain
`wat.tilmonengineering.com`, with `workers.dev` disabled. Confirm the domain's
Cloudflare zone is active in the selected account and inspect existing hostname
records before deploying. Wrangler manages custom-domain DNS and certificates;
do not overwrite a conflicting record. The separate one-click template is not
the deployment path used here.

Before the first deployment, ensure the `sentinel-attachments` R2 bucket exists
in that account (`wrangler r2 bucket create sentinel-attachments`). Keep the
`AuthState` and `ProjectState` bindings and the `v1` migration history unchanged.
Run the local release checks and Wrangler dry-run before deploying.

For a **fresh installation**, do not run the public deployment command above
first. Create a temporary Wrangler config beside `packages/workers-sentinel/wrangler.jsonc`
that copies its code, build, assets, compatibility, R2, and Durable Object settings,
but omits `routes` and keeps `workers_dev: false`. From the Worker package directory,
deploy that config with the account pinned and explicit `--config` selection. Set
`SETUP_TOKEN` using `wrangler secret put SETUP_TOKEN --config <bootstrap-config>`;
use a securely generated value, never source-controlled configuration. Confirm the
secret name is present and the Worker has no public deploy targets before deploying
`wrangler.jsonc`. Secret provisioning itself deploys a version, so keep selecting
the route-free config until the secret is installed. Retain the bootstrap config
until production verification succeeds, then remove it.

Register the first administrator with the setup token, then immediately disable
open registration in admin settings (`registrationOpen: false`). Verify anonymous
registration returns `403 registration_disabled` before running the production
smoke script. Use a dedicated temporary project and API token for the smoke, then
delete the project and revoke the token. Store credentials outside Git; a local
`.env`, if used, must remain git-ignored and owner-readable only.

### Local Development (guarded supervisor)

Run the full stack locally under Workerd — no Cloudflare account or credentials needed:

```bash
just install            # pnpm install across the workspace (mise pins node/pnpm/just via mise.toml)
just dev-up             # foreground local supervisor: dashboard + worker + Durable Objects on 127.0.0.1
just send-demo-events   # seed a demo user/project/events to see ingestion and grouping
just dev-down           # authenticated stop from another terminal
```

The supervisor (in `_devenv/cloudflare/`) is loopback-only, persists Durable Object state under `_devenv/cloudflare/.state/`, and strips Cloudflare credentials from child processes so local development cannot reach your Cloudflare account. See AGENTS.md for the full command list and the stale-state reconciliation runbook.

### First-Time Setup

1. **Deploy your worker** to Cloudflare
2. **Visit your worker URL** in a browser
3. **Register the first user** - this becomes your admin account
4. **Create your first project** - you'll receive a DSN
5. **Configure your Sentry SDK** with the DSN

## SDK Configuration

Workers Sentinel speaks the Sentry **ingestion** protocol (envelope and legacy store endpoints, DSN auth) — use your Sentinel DSN wherever a Sentry DSN works. The fetch side has two surfaces: a native JSON API (`/api/projects/…`) for the dashboard, and a Sentry-shaped `/api/0` API for agents and Sentry-speaking clients — project/issue discovery, issue triage (`PUT {"status":"resolved"}` marks complete), events, event-id lookup, comments, and event attachments (list/metadata/`?download` byte stream) with Sentry's serializers, `Link` pagination, and `{"detail": …}` errors. `sentry-cli` is not supported. See AGENTS.md ("The `/api/0` API") for the exact contract and deviations.

### Cloudflare Workers (Service Binding with RPC)

For Cloudflare Workers, you can use [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) with RPC for optimal performance. This routes requests internally within Cloudflare's network, avoiding external HTTP roundtrips and reducing latency.

**Step 1:** Add a service binding to your worker's `wrangler.jsonc`:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_flags": ["nodejs_als"],
  "services": [
    { "binding": "SENTINEL", "service": "workers-sentinel", "entrypoint": "SentinelRpc" }
  ]
}
```

**Step 2:** Initialize Sentry with the RPC transport:

```typescript
import * as Sentry from '@sentry/cloudflare';
import { waitUntil } from 'cloudflare:workers';

const DSN = 'https://<public_key>@<your-worker>.workers.dev/<project_id>';

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: DSN,
    transport: () => ({
      send: async (envelope) => {
        const rpcPromise = env.SENTINEL.captureEnvelope(DSN, envelope);
        waitUntil(rpcPromise);
        const result = await rpcPromise;
        return { statusCode: result.status };
      },
      flush: async () => true,
    }),
  }),
  {
    async fetch(request, env, ctx) {
      // Your worker code here
      return new Response('Hello!');
    },
  }
);
```

The `waitUntil` call ensures the RPC completes even after the HTTP response returns. The `captureEnvelope` method takes the DSN and envelope, handling authentication and ingestion internally.

### JavaScript / Browser

```javascript
import * as Sentry from '@sentry/browser';

Sentry.init({
  dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
});
```

### Website feedback widget (browser)

The feedback widget is a separate, framework-independent browser SDK with no React or Vue runtime dependency. It does not report through Sentry's error-event protocol. The prepared package name is `@workers-sentinel/feedback-sdk`, version `0.1.0`; it has **not been published**, and registry ownership/publish permission has not been verified. Do not rely on an npm CDN URL until an authorized release exists.

For this checkout, build and pack the SDK, then install its tarball in your website project:

```sh
# In this repository
pnpm install
pnpm --filter @workers-sentinel/feedback-sdk build
cd packages/feedback-sdk
npm pack

# In your website project (adjust the repository path)
npm install /path/to/workers-sentinel/packages/feedback-sdk/workers-sentinel-feedback-sdk-0.1.0.tgz
```

After an authorized npm release, the equivalent registry installation is `npm install @workers-sentinel/feedback-sdk@0.1.0`. Initialize either installation with the project's public DSN (shown at project creation and in Project Settings):

```javascript
import { installFeedbackWidget } from '@workers-sentinel/feedback-sdk';

const feedback = installFeedbackWidget({
  dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
  launcherLabel: 'Send feedback',
  placement: 'bottom-right',
  theme: { accentColor: '#c9234a', backgroundColor: '#ffffff' },
  styleNonce: document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content'),
  privateSelectors: ['.customer-private'],
  collectMetadata: async ({ pageUrl, locator }) => ({
    release: 'website-1.0.0',
    page: pageUrl,
    selectedElement: locator,
  }),
});

// Call feedback.destroy() when your application no longer needs the widget.
```

The Sentinel deployment also hosts the standalone SDK at `https://wat.tilmonengineering.com/sdk/feedback.js`, with a version-pinned copy at `https://wat.tilmonengineering.com/sdk/v0.1.0/feedback.js`. Dashboard builds include both files automatically. For another hosting setup, copy the built `packages/feedback-sdk/dist/browser.iife.js` to your website's public `/assets/` directory or your static CDN:

```html
<script src="/assets/browser.iife.js"></script>
<script>
  window.WorkersSentinelFeedback.install({
    dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
    launcherLabel: 'Send feedback',
    privateSelectors: ['.customer-private'],
    collectMetadata: async (context) => ({
      release: 'website-1.0.0',
      page: context.pageUrl,
    }),
  });
</script>
```

After publication, a version-pinned npm CDN URL such as `https://cdn.jsdelivr.net/npm/@workers-sentinel/feedback-sdk@0.1.0/dist/browser.iife.js` can replace the local `src`. Your host CSP must allow the script origin (and your initialization script's nonce/hash) and `connect-src` to your Sentinel instance.

Both entry points expose equivalent initialization. The DSN public key is intentionally public and grants submission only; it cannot read feedback. The feedback API accepts credential-less wildcard CORS for cross-origin `POST` and preflight, independent of `CORS_ORIGINS`. Members browse submissions in the project's **Feedback** view. The service currently caps each submission body at 2 MiB, each screenshot at 1.5 MiB, callback metadata at 8 KiB (5 nesting levels and 100 entries per object/array), the complete metadata field at 12 KiB, and feedback submissions at 100 per project per hour. Screenshot bytes share the project's existing attachment budget and retention policy; after project purge, a content-free prefix tombstone and cleanup alarm reclaim uploads that finish late. PNG/JPEG/WebP type/signature agreement is checked server-side; this is not full image decoding or a guarantee of corruption-free images. Set `screenshots: false` to disable capture and require a deliberate text-only submission.

Picking an element temporarily intercepts pointer activation; press **Escape** or Cancel to restore the page. The SDK stores a bounded locator and rectangle, not arbitrary DOM, full text, form values, or field contents. Opening the launcher starts element selection without showing the form. Selecting an element automatically captures a best-effort masked screenshot, then opens the form with the locator and image ready for review. The visitor enters a description and chooses **Send feedback**; nothing is uploaded until then. After success, the widget is ready for another report without reloading the page. The optional `collectMetadata(context)` callback runs at submission and receives bounded `pageUrl`, `pageTitle`, `description`, `locator`, and `geometry` context; return JSON-safe data only (up to 8 KiB). Do not return secrets or personal data. The callback has a short timeout; if it fails or times out, the form explains the issue and requires the visitor to choose whether to continue without the extra metadata.

The widget is mounted in a Shadow DOM. Configure `styleNonce` when your host page uses a CSP nonce; strict Content Security Policy may otherwise block injected styles or renderer resources. Screenshot capture uses best-effort DOM rendering, not a native browser-tab screenshot. Password controls, `[data-sentinel-feedback-private]`, and configured `privateSelectors` are masked and cannot be disabled. Cross-origin images/fonts, tainted canvases, unsupported CSS, very long documents, and browser restrictions may make the image incomplete or unavailable. Capture starts automatically after element selection; the preview is shown for review before Send. If capture fails, the form clearly warns that no screenshot is attached, and the visitor can still send the description and selected-element context without an additional fallback step. Site owners are responsible for explaining consent/privacy expectations; screenshots can include visible page content beyond the selected element. Closed shadow roots and cross-origin frames are not traversed, and same-origin iframe selection is not supported.

### Enable feedback on Sentinel's own dashboard

Set the optional Worker deployment variable `FEEDBACK_DSN` to the project's public DSN in `packages/workers-sentinel/wrangler.jsonc` (`vars`) or your deployment configuration. Redeploy to apply it. No dashboard configuration UI exists; omitting or blanking the variable disables the installation.

```jsonc
"vars": {
  "FEEDBACK_DSN": "https://PUBLIC_KEY@your-sentinel-host/PROJECT_ID"
}
```

The dashboard reads only this public value from `/api/dashboard-config`, loads its same-origin `/sdk/feedback.js`, and installs one **Send feedback** launcher. It adds the current route as application metadata (not session credentials or user identity) and masks inputs, textareas, and selects in addition to the SDK's mandatory private masks. The launcher starts selection immediately; capture runs automatically before the form appears, and only **Send feedback** uploads the report. The host CSP must permit the DSN's origin under `connect-src`; same-origin DSNs work with the default policy.

### Node.js

```javascript
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
});
```

### Python

```python
import sentry_sdk

sentry_sdk.init(
    dsn="https://<public_key>@<your-worker>.workers.dev/<project_id>",
)
```

### Go

```go
import "github.com/getsentry/sentry-go"

sentry.Init(sentry.ClientOptions{
    Dsn: "https://<public_key>@<your-worker>.workers.dev/<project_id>",
})
```

The DSN is displayed when you create a project in the dashboard, or you can find it in the project settings.

## Webhook Notifications

Workers Sentinel can send a POST request to any HTTP endpoint when a new issue is detected. This enables integration with Slack, Discord, PagerDuty, or any custom alerting system.

### Setup

1. Go to **Project Settings** in the dashboard
2. Enter your webhook URL in the **Webhook Notifications** section
3. Click **Save**
4. Use **Send Test** to verify the endpoint receives notifications

Webhook URLs must use HTTPS.

### Payload Format

When a new issue is detected, Workers Sentinel sends a JSON POST request:

```json
{
  "text": "[My App] New error: TypeError: Cannot read property 'foo' of undefined in app.js",
  "project": {
    "id": "project-uuid",
    "name": "My App",
    "slug": "my-app"
  },
  "issue": {
    "id": "issue-uuid",
    "title": "TypeError: Cannot read property 'foo' of undefined",
    "level": "error",
    "culprit": "app.js"
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

The `text` field is formatted for direct use with Slack Incoming Webhooks. For Discord, use the same URL format with `/slack` appended to your Discord webhook URL.

### Notes

- Webhooks fire only for **new** issues (first occurrence of a unique error fingerprint)
- Delivery is best-effort — failures are logged but not retried
- Webhook requests are sent asynchronously and never slow down event ingestion

## Managing Team Members

Workers Sentinel supports sharing projects with other registered users through role-based access control.

### Roles

- **Owner** — The project creator. Full access, cannot be removed or changed.
- **Admin** — Can manage members (add, remove, change roles) and update project settings.
- **Member** — Can view the project, its issues, and events.

### Adding Members

1. Go to **Project Settings** in the dashboard
2. Scroll to the **Team Members** section
3. Enter the user's email address and select a role
4. Click **Add**

Users must register an account before they can be added to a project. There is no invitation system — members are added by their registered email address.

## API Tokens

API tokens allow programmatic access to the Workers Sentinel API — useful for CI/CD pipelines, scripts, custom dashboards, and integrations with incident management tools.

### Creating a Token

1. Go to **Project Settings** in the dashboard
2. Click **Manage API Tokens** in the API Tokens section
3. Enter a token name (e.g., `ci-pipeline`) and an optional expiration date
4. Click **Create Token**
5. **Copy the token immediately** — it will only be shown once

### Using a Token

Include the token in the `Authorization` header of any API request:

```bash
# List projects
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects

# Get issues for a project
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects/my-app/issues

# List events for an issue
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects/my-app/issues/issue-uuid/events
```

API tokens use the `wst_` prefix and work alongside existing session-based authentication.

### Token Management

- **Expiration**: Tokens can be created with an optional expiration date. Expired tokens are automatically rejected.
- **Revocation**: Revoke tokens from the API Tokens dashboard page. Revoked tokens stop working immediately.
- **Limits**: Each user can have up to 10 active API tokens.
- **Audit**: Each token's Last Used timestamp is updated on each successful request.

### Security Best Practices

- Store tokens in environment variables, never in source code
- Use descriptive names so you can identify which token belongs to which service
- Set expiration dates for tokens used in temporary or rotating access scenarios
- Revoke tokens immediately when they are no longer needed or may be compromised
- Token management (creating, listing, revoking) requires session authentication — a compromised API token cannot create new tokens

### MCP project triage

An MCP client can read and triage issues and feedback for one project through a stateless HTTP endpoint using a `wst_` API token. Configure the client with `https://<sentinel-host>/api/projects/<project-slug>/mcp` and a static `Authorization: Bearer wst_…` header. This API-key auth mode is not MCP OAuth. See [docs/mcp.md](docs/mcp.md) for setup, transport behavior, tool contracts, pagination, and security boundaries.

## Architecture

Workers Sentinel is built with modern web technologies:

**Backend (Worker):**
- **Hono** - Fast, lightweight web framework
- **Cloudflare Durable Objects** - Distributed state with SQLite storage
- **Sentry Envelope Parser** - Compatible with Sentry SDK wire format

**Frontend (Dashboard):**
- **Vue.js 3** - Progressive JavaScript framework
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first styling
- **Pinia** - State management
- **Vite** - Fast build tooling

**Data Architecture:**
- **AuthState DO** (singleton) - Users, sessions, project registry
- **ProjectState DO** (per-project) - Issues, events, statistics

Each project has its own isolated Durable Object with SQLite storage, ensuring data isolation and scalability.

**Rate Limiting:**
- Per-project configurable hourly event quotas stored in the ProjectState DO
- In-memory counter with persistent backup in SQLite for fast O(1) checks
- Returns HTTP 429 with `Retry-After` header when quota is exceeded — Sentry SDKs handle this gracefully
- Default is unlimited (0); configurable via dashboard or `PATCH /api/projects/:slug`

## Roadmap & Future Enhancements

Planned features for future releases:

- [x] Source map support for JavaScript errors
- [ ] Release tracking and deployment correlation
- [ ] Performance monitoring (transactions, spans)
- [x] Webhook alerting notifications
- [ ] Email alerting notifications
- [ ] Session replay support
- [x] Team/organization support
- [ ] Issue assignment
- [x] Tag-based search and filtering
- [x] Time-series charts
- [x] Rate limiting per project
- [x] Event retention policies

## Known Limitations

**Current Limitations:**
- No performance monitoring (error tracking only)
- Email notifications not yet available (webhooks supported)
- No project ownership transfer (creator remains permanent owner)

**Sentry Feature Parity:**
Workers Sentinel focuses on core error tracking. Advanced Sentry features like:
- Session replay
- Performance monitoring
- Profiling
- Crons monitoring

Are not currently supported but may be added in future versions.

**Browser Compatibility:**
- Modern browsers required (Chrome 90+, Firefox 88+, Safari 14+)
- JavaScript must be enabled
- Cookies must be enabled for authentication

## Contributing

We welcome contributions from the community!

**🐛 Bug Reports**
- Use the [GitHub Issues](https://github.com/G4brym/workers-sentinel/issues) page
- Include reproduction steps
- Specify your environment

**✨ Feature Requests**
- Check existing issues first
- Explain the use case and benefit

**💻 Code Contributions**
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a Pull Request

**Development Setup:**
```bash
# Clone and install
git clone https://github.com/G4brym/workers-sentinel.git
cd workers-sentinel
pnpm install

# Start development (runs wrangler dev)
pnpm dev

# Build dashboard
pnpm --filter @workers-sentinel/dashboard build

# Typecheck
pnpm typecheck

# Lint
pnpm lint
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for the self-hosted community**

If you find Workers Sentinel useful, please consider giving it a ⭐ on GitHub!
