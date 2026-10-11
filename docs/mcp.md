# Project-scoped MCP access

Workers Sentinel exposes a stateless Model Context Protocol (MCP) HTTP endpoint for ordinary issue and feedback triage within one project:

```text
POST https://<sentinel-host>/api/projects/<project-slug>/mcp
GET  https://<sentinel-host>/api/projects/<project-slug>/mcp
```

The URL fixes the project context. Tools do not accept a project id or slug, and a token must belong to a user who is a member of that project. An unknown or inaccessible project returns the same not-found response.

## Authentication and client setup

Create an API token from the account's **API Tokens** page. Use the `wst_` API token, not a dashboard session token or a project's public DSN. Store it in your MCP client secret/configuration store; never commit it or put it in prompts or source files.

Configure a Streamable HTTP MCP client with the full project endpoint URL and a static request header:

```json
{
  "url": "https://sentinel.example/api/projects/my-app/mcp",
  "headers": {
    "Authorization": "Bearer wst_REPLACE_WITH_YOUR_TOKEN"
  }
}
```

The MCP endpoint validates the API token and project membership on every request. Expired, revoked, invalid, and session tokens are rejected. Requests with an `Origin` must be same-origin or use an exact origin in the Worker's `CORS_ORIGINS` allowlist; the HTTP Host must match the request URL host. Non-browser clients can omit Origin. This MCP integration implements API-key bearer authentication, **not MCP OAuth authorization**. MCP clients that require OAuth-only connections need a later OAuth-compatible integration or another auth mode.

The server uses stateless Streamable HTTP: POST supports MCP initialization, `tools/list`, and `tools/call`; GET returns 405 because this endpoint does not offer a server-to-client event stream. Send one JSON-RPC message per POST (batches are unsupported), with `Content-Type: application/json` and an Accept header that includes both `application/json` and `text/event-stream`. Inputs and request bodies are bounded; tool results use the SDK's JSON/SSE response negotiation.

### Initialization example

After setting `SENTINEL_API_TOKEN` in your local environment, initialize using the project URL (replace the host/slug):

```sh
curl https://sentinel.example/api/projects/my-app/mcp \
  -H "Authorization: Bearer $SENTINEL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"triage-client","version":"1.0.0"}}}'
```

Then POST a separate `notifications/initialized` message (no `id`), followed by `tools/list` or `tools/call`, with the same headers and `MCP-Protocol-Version: 2025-11-25`. For example, a call body is `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_feedback","arguments":{"status":"unresolved","limit":25}}}`. Initialization creates no persisted MCP session; keep sending the API token on every request. Clients must parse both JSON responses and SSE `data:` message events.

## Tools

All IDs below refer only to the project in the URL.

| Tool | Inputs | Behavior |
|---|---|---|
| `list_issues` | optional `status` (`unresolved`, `resolved`, `ignored`, `snoozed`), `level`, `environment`, `query`, `tags` (up to 5 `key:value` strings), `sort`, `cursor`; `limit` 1–100 (default 25) | Filtered issue page. Pass `nextCursor` as `cursor` for the next page. |
| `get_issue` | `issueId` | Issue detail and recent statistics. |
| `list_issue_events` | `issueId`, optional `cursor`, `limit` | Newest-first keyset page of events. |
| `list_issue_comments` | `issueId`, optional `cursor`, `limit` | Keyset page of comments. |
| `set_issue_status` | `issueId`, `status` (`resolved`, `unresolved`, `ignored`) | Update status and attribute activity to the authenticated user. |
| `add_issue_comment` | `issueId`, `body` (1–2000 characters) | Add a comment attributed to the authenticated user. |
| `snooze_issue` | `issueId`, `duration` (`1h`, `1d`, `3d`, `1w`, or a future ISO timestamp) | Snooze an issue. |
| `unsnooze_issue` | `issueId` | Clear an issue snooze. |
| `list_feedback` | optional `status` (`unresolved`, `resolved`), `query` (up to 200 characters), `cursor`; `limit` 1–100 (default 25) | Omitted status means all feedback. Returns status and supports keyset paging. |
| `get_feedback` | `feedbackId` | Public feedback detail; internal screenshot object keys are not returned. |
| `get_feedback_screenshot` | `feedbackId` | Return the feedback screenshot as an MCP image content block (`image/png`, `image/jpeg`, or `image/webp`); reports without an image return a safe tool error. |
| `set_feedback_status` | `feedbackId`, `status` (`resolved`, `unresolved`) | Mark feedback resolved or reopen it. It remains stored; this does not delete it. |

Issue and feedback pages return their rows, `hasMore`, and an optional `nextCursor` (omitted when exhausted). Comments use oldest-first ordering with an id tie-break; events and feedback use newest-first ordering with an id tie-break. Use the cursor with the same filter/sort parameters. Values may change while paging, so refresh from the first page to see a fully current view.

Input contracts: IDs are 1–80 characters; issue-list cursors are at most 1024 characters (to accommodate bounded exception titles), and other cursors are at most 300 characters; text queries are at most 200 characters; environment is at most 100 characters; each of up to five tags is a `key:value` string at most 200 characters; `level` is `fatal`, `error`, `warning`, `info`, or `debug`; `sort` is `last_seen` (default), `first_seen`, `count`, `user_count`, `level`, or `title`, descending. Issue lists omit currently snoozed issues unless `status: "snoozed"` is selected. Tool arguments reject extra fields, including project identifiers. The HTTP body is capped at 32 KiB and serialized JSON tool results at 2 MiB. If a result is too large, a safe `result_too_large` tool error is returned; reduce `limit` for list tools. JSON-returning tools use text content; `get_feedback_screenshot` returns MCP image content, base64-encoded by the protocol, and limits screenshots to the existing 1.5 MiB upload cap. Failed operations return `isError: true` with a safe reason such as `issue_not_found` or `feedback_not_found`.

## Security boundaries

- One MCP endpoint is scoped to one URL-selected project; there is no cross-project discovery tool.
- MCP tools provide read and ordinary triage only. They do not delete or merge issues, or delete feedback.
- Feedback output omits internal screenshot storage keys.
- Public DSNs are only for event/feedback ingestion and cannot authenticate to MCP.
- API token scopes are not modeled: a valid token with project membership has the listed tool capabilities. Create a dedicated, expiring token and revoke it when no longer needed.
