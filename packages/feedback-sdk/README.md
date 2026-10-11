# Workers Sentinel Feedback SDK

Framework-independent browser feedback widget, distributed as ESM with TypeScript declarations and a standalone IIFE browser bundle. Screenshot capture uses [`html-to-image`](https://github.com/bubkoo/html-to-image) (MIT).

## Installation

Registry publication is not confirmed. Use the hosted standalone script below, or build a local package/tarball from this source checkout:

```sh
pnpm --filter @workers-sentinel/feedback-sdk build
cd packages/feedback-sdk
npm pack
# In the website project, install the actual tarball generated above:
npm install /path/to/workers-sentinel-feedback-sdk-0.1.0.tgz
```

Build output includes ESM and declarations under `dist/` plus the standalone `dist/browser.iife.js` script bundle.

## ESM

```ts
import { installFeedbackWidget } from '@workers-sentinel/feedback-sdk';

const widget = installFeedbackWidget({
  dsn: 'https://PUBLIC_KEY@sentinel.example/PROJECT_ID',
  launcherLabel: 'Report a problem',
  placement: 'bottom-right',
  styleNonce: window.cspNonce,
  theme: { accentColor: '#7c3aed' },
  privateSelectors: ['.account-number', '[data-private]'],
  collectMetadata: (context) => ({ appVersion: '2.4.0', page: context.pageTitle }),
});

widget.open();
widget.close();
widget.destroy();
```

Connection fields may be used instead of a DSN:

```ts
installFeedbackWidget({
  serverUrl: 'https://sentinel.example',
  projectId: 'PROJECT_ID',
  publicKey: 'PUBLIC_KEY',
});
```

## Standalone browser script

```html
<script src="https://sentinel.example/sdk/feedback.js"></script>
<script>
  const widget = window.WorkersSentinelFeedback.install({
    dsn: 'https://PUBLIC_KEY@sentinel.example/PROJECT_ID',
    launcherLabel: 'Send feedback'
  });
</script>
```

Replace `sentinel.example` with the origin from your project's DSN, and copy the real DSN from project settings or the feedback screen. The dashboard build emits `/sdk/feedback.js`, `/sdk/v0.1.0/feedback.js`, and the [SDK guide](SKILL.md) at `/sdk/SKILL.md`. Place the scripts after the document body exists, without `async`, or wait for the script load before initialization. Host CSP must allow the SDK script, its styles, and connections to your Sentinel origin.

## Feedback backlog

The feedback screen displays `unresolved`/`resolved` status, text/status filters, 25/50/100 page sizes, and resolve/reopen actions in both list and detail. Resolving keeps the report and its screenshot; reopening sets it back to unresolved. The native members-only list supports `status`, `query` (up to 200 characters across description/title/URL), `limit`, and `cursor`, and `PATCH /api/projects/:slug/feedback/:id` accepts `{ "status": "resolved" | "unresolved" }`. Omit status to list both states. MCP tools offer the same project-scoped backlog operations; see [the MCP guide](../../docs/mcp.md).

## Capture and privacy behavior

- The launcher and form are inside Shadow DOM. The fixed host is pointer-transparent outside the launcher and panel, so normal page interactions continue; placement can be set to `top-left`, `top-right`, `bottom-left`, or `bottom-right`.
- The element picker records a bounded CSS locator plus document-relative geometry (`x`, `y`, `width`, `height`) only; opening the launcher begins selection without showing a form. Selecting an element automatically captures a best-effort screenshot, then displays the form with the locator and preview ready for review. Enter a description and choose **Send feedback** to upload; no upload happens during selection or capture. After success, start another report without reloading the page. Locators prefer unique id, `data-testid`, `data-test`, `data-qa`, `data-cy`, or role attributes before a bounded structural path. Picker listeners and temporary highlighting are removed on Escape, selection, close, or destruction.
- The screenshot is of the document, not only the selected node. The widget itself is filtered out. Mandatory private selectors are `input[type="password"]` and `[data-sentinel-feedback-private]`; `privateSelectors` adds selectors and cannot disable built-in masks. Matching private elements are excluded from the renderer, and their measured visible regions and descendant overflow rectangles are covered with opaque pixels in the output bitmap, independently of page z-index. Moving private content remains excluded; excluding a private region may affect surrounding image layout. Marking the document root private omits the screenshot. The selected element rectangle is outlined. Review the preview before sending; rendering is best effort, not a native tab screenshot. Closed shadow roots and iframes are not traversed.
- The page URL is bounded, omits credentials and fragments, and removes query parameters whose names match token, secret, password, auth, API key, session, or code. Page title is capped at 300 characters. Avoid putting sensitive data in URLs or page titles regardless.
- The worker accepts a multipart `metadata` JSON string (≤12 KiB) and an optional `screenshot` file (PNG/JPEG/WebP, ≤1.5 MiB); the complete request is capped at 2 MiB. The metadata JSON shape is `{ description, pageUrl, pageTitle, locator, geometry, metadata }`, with a description ≤4000 characters, URL ≤2048, title ≤300, locator ≤1000, and optional geometry `{x,y,width,height}`. `metadata` is the JSON value returned by `collectMetadata` and is capped at 8 KiB, nesting depth 5, and 100 entries per array/object.
- Screenshot capture failure displays a warning in the form and does not block submission. Choosing **Send feedback** sends a text-only report when the warning says no screenshot is attached. If the optional metadata hook throws, times out, returns non-JSON/oversized data, or violates the metadata limit, the user must separately choose **Continue without metadata**.
- `styleNonce` is applied to the widget's style element for CSP deployments. Requests use `credentials: 'omit'` and send public DSN authentication as `sentry_key` in the endpoint query string.

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `dsn` | `string` | — | Sentry-style DSN; alternative to explicit connection fields. Accepts `/project` or deployment `/prefix/api/project` path shapes. |
| `serverUrl` | `string` | — | HTTP(S) base URL; trailing `/api` is normalized. |
| `projectId` | `string` | — | Project id in the feedback endpoint path. |
| `publicKey` | `string` | — | Public ingestion key sent as `sentry_key`. |
| `launcherLabel` | `string` | `Feedback` | Launcher text and accessible name. |
| `styleNonce` | `string` | — | CSP nonce on the widget `<style>`. |
| `privateSelectors` | `string[]` | `[]` | Additional selectors for opaque screenshot covers. |
| `collectMetadata` | `(context) => unknown \| Promise<unknown>` | — | Optional bounded application metadata hook. Context has `pageUrl`, `pageTitle`, `description`, `locator`, and `geometry`. Only plain JSON data is accepted; secrets must never be returned. |
| `screenshots` | `boolean` | `true` | Set false to disable capture; the form states that no screenshot is attached. |
| `theme` | `FeedbackTheme` | built-in theme | Color overrides: `accentColor`, `accentTextColor`, `backgroundColor`, `textColor`, `mutedColor`, `borderColor`. |
| `placement` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `bottom-right` | Widget placement. |
| `maxPayloadBytes` | `number` | 2 MiB | Local request cap; cannot exceed the worker's 2 MiB limit. |
| `maxMetadataBytes` | `number` | 8 KiB | Hook metadata bound; cannot exceed the worker's 8 KiB limit. |
| `metadataTimeoutMs` | `number` | 1500 | Hook timeout; maximum 5000 ms. |
| `screenshotScale` | `number` | `1` | Scale clamped to 0.25–2 and reduced for image dimensions. |
| `fetch` | `typeof fetch` | global `fetch` | Optional transport override. |
| `onSubmit` | `(result) => void` | — | Receives success/failure status. |

## Build and tests

From this directory, with dependencies available:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

The browser test loads the emitted ESM and standalone script artifacts in Chromium and asserts picker cancellation, final-element selection, consent, annotation/mask pixels, metadata, and multipart content. If the workstation's default temporary directory rejects writes, set `TMPDIR` to a writable repository-local directory.

## Endpoint

The SDK submits `POST /api/{projectId}/feedback?sentry_key={publicKey}`. The endpoint must accept the `metadata` JSON multipart field and optional `screenshot` file described above. The public key grants ingestion only; the SDK does not attach session credentials. Cross-origin use requires CORS permission for the embedding origin and multipart POST.
