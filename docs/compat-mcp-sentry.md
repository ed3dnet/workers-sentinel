# MCP do Sentry contra o `/api/0` do Sentinel

Teste feito em 25/11/2026 com `@sentry/mcp-server` **0.51.0** (stdio), apontado para o worker local
(`SENTRY_URL=http://127.0.0.1:8787`, token pessoal `wst_` do usuário demo), projeto `cli-feedback`.
Cada ferramenta foi chamada por um cliente MCP mínimo e as rotas foram conferidas no log do worker.

## Como configurar (a versão 0.51 mudou a linha de comando)

`--host` e `--access-token` foram descontinuados. O servidor agora roda com o subcomando `mcp` e lê
o endereço e o token de variáveis de ambiente:

```bash
claude mcp add sentinel \
  -e SENTRY_URL=https://sentinel.example.com \
  -e SENTRY_AUTH_TOKEN=wst_… \
  -- npx -y @sentry/mcp-server@0.51.0 mcp
```

A versão fica fixa porque a compatibilidade foi verificada só nela; o `@latest` já mudou a interface uma vez.
Sem chave de LLM (`ANTHROPIC_API_KEY` etc.) a busca em linguagem natural fica desligada, mas a busca
com sintaxe direta (`is:unresolved`) continua funcionando.

## Resultado por ferramenta

Primeira rodada em 25/11/2026; novas rodadas no mesmo dia, depois das correções do worker (itens 1–6 abaixo),
com o mesmo cliente MCP contra o `wrangler dev` local e os dados do `_devenv/cloudflare/demo.mjs`.

| Ferramenta | Resultado | Rota chamada / observação |
|---|---|---|
| `whoami` | ✅ funciona | `GET /auth/` (usuário do token: `id`, `name`, `email`) |
| `find_organizations` | ✅ funciona | `GET /organizations/` |
| `find_projects` | ✅ funciona | `GET /organizations/{org}/projects/` |
| `search_issues` (com ou sem `projectSlugOrId`) | ✅ funciona | `GET /projects/{org}/{project}/` + `GET /organizations/{org}/issues/?project=…&query=is:…` |
| `get_issue_details` (com `issueId` ou `issueUrl`) | ✅ funciona | id aceito sem diferenciar maiúsculas; `release` do evento vem como objeto ou `null`; exceções com frames, contexto de código e `mechanism`, e o `request` |
| `get_sentry_resource` (URL de issue) | ✅ funciona | mesmo caminho do `get_issue_details` |
| `update_issue` | ✅ funciona | `GET` + `PUT /organizations/{org}/issues/{id}/` |
| `add_issue_note` | ✅ funciona | `POST …/issues/{id}/notes/` (texto em `data.text`) |
| `get_issue_activity` | ✅ funciona | `GET …/issues/{id}/activities/` + `…/notes/`: notas, mudanças de status (`set_resolved` etc.) e `first_seen` |
| `search_issue_events` | ✅ funciona | `GET /organizations/{org}/issues/{id}/events/` |
| `get_event_attachment` | ✅ funciona | `GET /projects/{org}/{project}/events/{event}/attachments/` |
| `get_issue_breadcrumbs` | ✅ funciona | entrada `breadcrumbs` do evento (timestamps em ISO, mesmo quando o SDK manda segundos) |
| `get_event_stacktrace` | ✅ funciona | lê só as entradas `threads` ou `stacktrace` (escolhe a thread que travou). Para exceções JavaScript/Node, que não têm threads, a resposta é `no_threads`, como no Sentry de verdade; os frames da exceção aparecem no `get_issue_details` |
| `search_errors` | ❌ 404 | usa o Discover (`/organizations/{org}/events/`), que o Sentinel não tem |
| `find_releases`, `find_teams`, `find_dsns` | ❌ 404 | `releases/`, `teams/`, `keys/` não existem no `/api/0` |
| Monitores, alertas, traces, replays, profiles, dashboards | — fora do escopo | o Sentinel não tem esses recursos |

## O que foi corrigido no worker

1. Id da issue aceito sem diferenciar maiúsculas/minúsculas em todas as rotas `/api/0/…/issues/{id}/…`
   (o MCP converte o id para maiúsculas porque o trata como *short ID* `PROJ-123`).
2. `release` do evento serializado como objeto (`{"version": "…", "shortVersion": "…", …}`) ou `null`.
3. `…/issues/{id}/notes/` (GET/POST/DELETE) como apelido de `comments/`, e `…/issues/{id}/activities/` a partir do histórico da issue.
4. `GET /api/0/projects/{org}/{project}/` (detalhe do projeto, mesmo serializer da lista).
5. `GET /api/0/auth/` (usuário do token) para o `whoami`.
6. `entries` do evento montadas a partir do evento bruto (`exception`, `stacktrace`, `threads`, `message`, `breadcrumbs`,
   `request`), com frames no formato do Sentry (`lineNo`, `inApp`, `context`) — `src/lib/sentry-entries.ts`.

Os testes ficam em `packages/workers-sentinel/test/api0-mcp-compat.test.ts`.

## O que ainda falta

- Discover (`/organizations/{org}/events/`) para o `search_errors`.
- Releases, times e chaves (`find_releases`, `find_teams`, `find_dsns`).

O aviso da página **Connect** pode ser afrouxado para incluir detalhes da issue (com stack trace da exceção),
breadcrumbs, notas, atividade e busca por projeto. Os frames são os que o SDK mandou: o source map não é aplicado no `/api/0`.
