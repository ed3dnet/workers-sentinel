---
name: workers-sentinel-feedback-sdk
description: Install and configure the Workers Sentinel website feedback SDK, including app-specific metadata, privacy masks, CSP, and lifecycle handling.
---

# Workers Sentinel feedback SDK

Use this skill when adding visitor feedback to a website. The SDK is framework-independent browser JavaScript; do not add React/Vue dependencies or use Sentry error ingestion for feedback. This document describes SDK version 0.1.0.

## Before changing the website

1. Obtain the intended project's DSN from Workers Sentinel **Project Settings**. Do not invent a public key or project ID. Format: `https://PUBLIC_KEY@wat.tilmonengineering.com/PROJECT_ID`.
2. Identify the browser entry point and install once after the document body exists. Do not run the installer during server-side rendering. In an SPA, keep one installation for the app lifetime instead of reinstalling on every route.
3. Identify sensitive page regions and add privacy selectors or `data-sentinel-feedback-private` attributes. Explain that a submitted screenshot captures the page, not just the selected element. Respect the site's consent/privacy requirements.
4. Check CSP: allow the SDK script origin and `connect-src https://wat.tilmonengineering.com`. Initialization needs an allowed script nonce/hash or an external JS file. `styleNonce` applies to widget CSS; stricter renderer-resource policies can still prevent capture.

## Recommended standalone installation

Load this script before initialization. Do not use `async` unless initialization waits for its load event. Place the scripts near the end of the body, or initialize from your existing browser entry point after the script loads.

```html
<script src="https://wat.tilmonengineering.com/sdk/v0.1.0/feedback.js"></script>
<script>
  const feedback = window.WorkersSentinelFeedback.install({
    dsn: 'https://PUBLIC_KEY@wat.tilmonengineering.com/PROJECT_ID',
    launcherLabel: 'Send feedback',
    placement: 'bottom-right',
    privateSelectors: ['.customer-private', '[data-private]'],
    collectMetadata: async (context) => ({
      release: 'website-1.0.0',
      route: window.location.pathname,
      selectedElement: context.locator,
    }),
  });
</script>
```

Replace the DSN placeholders and metadata values with the host app's values. The stable URL is `https://wat.tilmonengineering.com/sdk/feedback.js`; prefer the version-pinned URL for controlled upgrades. The script exposes `window.WorkersSentinelFeedback.install(options)` and returns `{ open(), close(), destroy() }`. It does **not** install a widget merely by being downloaded.

For a custom trigger call `feedback.open()`. `close()` dismisses the form and cancels selection. Call `destroy()` when the app/widget owner is unmounted; it removes the host and listeners and invalidates pending UI work. Prevent duplicate installations yourself.

## ESM/npm alternative

The package name is `@workers-sentinel/feedback-sdk`. Registry publication and scope ownership are not confirmed; do not promise `npm install` or npm-CDN availability. Use a built local tarball until an authorized release exists:

```sh
# In the Workers Sentinel source checkout:
pnpm install
pnpm --filter @workers-sentinel/feedback-sdk build
cd packages/feedback-sdk
npm pack
# In the website project, use the actual generated tarball path:
npm install /path/to/workers-sentinel-feedback-sdk-0.1.0.tgz
```

```javascript
import { installFeedbackWidget } from '@workers-sentinel/feedback-sdk';
const feedback = installFeedbackWidget({
  dsn: 'https://PUBLIC_KEY@wat.tilmonengineering.com/PROJECT_ID',
  collectMetadata: async () => ({ release: 'website-1.0.0' }),
});
```

The ESM installer and standalone installer accept identical options. Alternatively supply `serverUrl`, `projectId`, and `publicKey` instead of `dsn`. Only HTTP(S) endpoints are supported.

## App-specific metadata callback

Register `collectMetadata(context)` in the options passed to the installer. The callback runs on **submission**, not at installation, selection, or capture. Read live app state inside the callback. It may return a JSON value synchronously or return a Promise.

Context fields (bounded by the SDK):

- `pageUrl`: sanitized page URL, at most 2048 characters; credentials, fragments, and sensitive-looking query parameters are removed.
- `pageTitle`: at most 300 characters.
- `description`: visitor's trimmed description, at most 4000 characters.
- `locator`: selected element locator, at most 1000 characters; not raw HTML or form values.
- `geometry`: `{ x, y, width, height }` in document CSS pixels, or null.

Return only plain JSON-safe data. Use null rather than undefined for absent object properties. Do not return functions, Dates/class instances, BigInt, symbols, accessors, circular references, sparse arrays, NaN, or Infinity. A top-level undefined return means no extra metadata. Maximum serialized result: **8192 UTF-8 bytes**, nesting depth **5**, and **100 entries per object/array**; keys are bounded to 100 characters. The complete feedback metadata field is capped at 12 KiB, so a large description and callback result can exceed it together.

Default callback timeout: **1500 ms**. `metadataTimeoutMs` may be set between 100 and 5000 ms. `maxMetadataBytes` may lower the 8192-byte cap but cannot raise it. On callback error/timeout/invalid/oversized data, the widget warns the visitor, requires **Continue without metadata**, then a separate **Send feedback** action. Do not suppress these warnings or auto-submit. Accepted data is shown under **Application metadata** in dashboard feedback detail.

Never return credentials, access tokens, session cookies, passwords, secrets, or unnecessary personal data. The DSN public key is deliberately public but does not authorize reads. Do not use a dashboard session token as an SDK credential.

## Configuration

- `launcherLabel`: button text; default `Feedback`.
- `placement`: `bottom-right` (default), `bottom-left`, `top-right`, or `top-left`.
- `theme`: object with optional `accentColor`, `accentTextColor`, `backgroundColor`, `textColor`, `mutedColor`, `borderColor`; use CSS color strings, not a theme-name string.
- `styleNonce`: site's CSP nonce for the injected widget style element.
- `privateSelectors`: additional valid CSS selectors. Invalid selectors cause installation failure rather than silently skipping privacy controls.
- `screenshots`: default true; false disables capture and requires a deliberate text-only choice before submission.
- `screenshotScale`: default 1; bounded to 0.25–2 and reduced to fit the 2048-pixel image-edge limit.
- `maxPayloadBytes`: optional lower request limit; cannot exceed 2 MiB.
- `collectMetadata`, `metadataTimeoutMs`, `maxMetadataBytes`: as above.
- `onSubmit(result)`: optional notification callback; result has `ok` and optional `status` or `error`.
- `fetch`: optional browser-compatible transport override. Normal transport uses `credentials: 'omit'`; do not attach cookies or private authorization.

## Visitor workflow and privacy

Open launcher → describe feedback → **Select an element** → click the final page element → review description → **Capture screenshot** → review masked page image and target outline → **Send feedback**. Escape cancels selection and restores page interaction. Picker intercepts page pointerdown/up/cancel and click; do not replace its event interception with ordinary click-only handling.

Password controls (`input[type="password"]`) and `[data-sentinel-feedback-private]` regions are always masked, plus `privateSelectors`. Masks are burned into the output bitmap and cannot be disabled by configuration. Other visible text/form content may contain sensitive data: mark it private explicitly. Closed shadow roots and iframe traversal are unsupported. Rendering uses MIT-licensed `html-to-image`, not native browser-tab screenshot APIs, session replay, or pixel-perfect capture.

Cross-origin assets/fonts, tainted canvases, unsupported CSS, page geometry changes, very long pages, or CSP can make rendering incomplete or fail. On capture failure the visitor must choose **Continue with text only** before sending without an image. Do not silently treat failure as a successful capture.

## Server contract and verification

Submission: credential-less `POST /api/PROJECT_ID/feedback?sentry_key=PUBLIC_KEY`. SDK creates multipart `metadata` (JSON string) plus optional `screenshot` (PNG Blob). Do not manually set multipart Content-Type; the browser must add the boundary. Worker enforces a 2 MiB body cap, 1.5 MiB screenshot cap, PNG/JPEG/WebP type/signature agreement, and a separate 100 submissions/project/hour quota. Images share the project attachment budget and retention policy. Type/signature checking is not full image decoding validation.

Project members view feedback through authenticated dashboard routes. Screenshot APIs require a member bearer token; never expose those tokens in a website embed or bypass membership with a bare image URL.

After integration, verify:

1. One launcher appears with the intended label/placement and without changing host styles.
2. Selecting a nested element identifies the final clicked element; Escape cancels and page controls work normally afterward.
3. Capture only occurs on deliberate capture action; preview masks password/default/custom-private regions and outlines the selection.
4. Callback sees current app state at submit; accepted metadata appears in the correct project's dashboard.
5. Callback/capture failures visibly require explicit omission choices; no secret appears in metadata, URL, title, or screenshot.
6. Destroying the widget removes its UI/listeners. Do not create production test accounts or records unless separately authorized.
