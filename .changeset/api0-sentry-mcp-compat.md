---
"workers-sentinel": minor
---

Close the `/api/0` gaps found with the official Sentry MCP server (`@sentry/mcp-server` 0.51.0): issue ids match case-insensitively, the event `release` is serialized as a Release object (or `null`), `…/issues/{id}/notes/` aliases `comments/` and `…/issues/{id}/activities/` lists the issue history, `GET /api/0/projects/{org}/{project}/` and `GET /api/0/auth/` are added, and events now carry Sentry `entries` (exception frames, threads, message, breadcrumbs, request).
