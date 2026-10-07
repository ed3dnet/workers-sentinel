# Workers Sentinel Feedback SDK

Framework-independent browser feedback widget, distributed as ESM with TypeScript declarations and a standalone IIFE browser bundle. Screenshot capture uses [`html-to-image`](https://github.com/bubkoo/html-to-image) (MIT).

## Installation

```sh
pnpm add @workers-sentinel/feedback-sdk
```

The package is prepared for publishing but has not been published. Build output includes ESM and declarations under `dist/` plus the standalone `dist/browser.iife.js` script bundle.

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
<script src="/assets/browser.iife.js"></script>
<script>
  const widget = window.WorkersSentinelFeedback.install({
    dsn: 'https://PUBLIC_KEY@sentinel.example/PROJECT_ID',
    launcherLabel: 'Send feedback'
  });
</script>
```

## Capture and privacy behavior

- The launcher and form are inside Shadow DOM. The fixed host is pointer-transparent outside the launcher and panel, so normal page interactions continue; placement can be set to `top-left`, `top-right`, `bottom-left`, or `bottom-right`.
- The element picker records a bounded CSS locator plus document-relative geometry (`x`, `y`, `width`, `height`) only; selection does not trigger screenshot rendering. Review the description, then click **Capture screenshot** to request capture. The preview appears for review before sending. Locators prefer unique id, `data-testid`, `data-test`, `data-qa`, `data-cy`, or role attributes before a bounded structural path. Picker listeners and temporary highlighting are removed on Escape, selection, close, or destruction.
- The screenshot is of the document, not only the selected node. The widget itself is filtered out. Mandatory private selectors are `input[type="password"]` and `[data-sentinel-feedback-private]`; `privateSelectors` adds selectors and cannot disable built-in masks. Matching visible regions and descendant overflow rectangles are covered with opaque pixels in the output bitmap, independently of page z-index. The selected element rectangle is outlined. Review the preview before sending; rendering is best effort, not a native tab screenshot. Closed shadow roots and iframes are not traversed.
- The page URL is bounded, omits credentials and fragments, and removes query parameters whose names match token, secret, password, auth, API key, session, or code. Page title is capped at 300 characters. Avoid putting sensitive data in URLs or page titles regardless.
- The worker accepts a multipart `metadata` JSON string (≤12 KiB) and an optional `screenshot` file (PNG/JPEG/WebP, ≤1.5 MiB); the complete request is capped at 2 MiB. The metadata JSON shape is `{ description, pageUrl, pageTitle, locator, geometry, metadata }`, with a description ≤4000 characters, URL ≤2048, title ≤300, locator ≤1000, and optional geometry `{x,y,width,height}`. `metadata` is the JSON value returned by `collectMetadata` and is capped at 8 KiB, nesting depth 5, and 100 entries per array/object.
- Screenshot capture failure never silently sends text-only feedback. The user must press **Continue with text only**. If the optional metadata hook throws, times out, returns non-JSON/oversized data, or violates the metadata limit, the user must separately choose **Continue without metadata**.
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
| `screenshots` | `boolean` | `true` | Set false to disable capture and require an explicit text-only choice. |
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
