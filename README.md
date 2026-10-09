# OpenClaw Chatwoot channel plugin

A thin, native [OpenClaw](https://docs.openclaw.ai) channel plugin that connects
OpenClaw to [Chatwoot](https://www.chatwoot.com).

- **Chatwoot owns** conversation history, assignment, and the human support workflow.
- **OpenClaw owns** agent execution and model selection.
- The plugin is a thin adapter: it validates and deduplicates Chatwoot webhooks,
  routes each conversation to a deterministic OpenClaw session, delivers agent
  replies through the Chatwoot public API, and hands off to a human reception
  team on terminal failure.

There is **no n8n** and **no separate integration microservice**. The separate
Help Center MCP server is untouched (`get_inbox`, `search_kb`, `get_article`).

## Architecture

```
Chatwoot ──webhook──▶ OpenClaw Gateway
                       └─ chatwoot plugin (registerHttpRoute)
                            ├─ verify signature (native X-Chatwoot or custom HMAC)
                            ├─ filter outgoing/private/self messages
                            ├─ dedupe by Chatwoot message id (durable)
                            ├─ route session chatwoot:<account_id>:<conversation_id>
                            ├─ run agent (retry; model failover is core-owned)
                            └─ deliver reply via Chatwoot public API (receipt id)
```

## Features

- Config for Chatwoot base URL, account id, API token, webhook secret/header,
  and reception team id.
- Webhook handler that validates the signature, filters `outgoing`/`private`
  messages, and deduplicates by Chatwoot message id.
- Deterministic session routing `chatwoot:<account_id>:<conversation_id>`.
- Outbound adapter using Chatwoot's public API with confirmed delivery receipts
  (the returned message id).
- Failure handler distinguishing **transient**, **quota**, **auth/config**, and
  **outbound delivery** failures.
- Configurable **fallback-model** behavior and **terminal failure handoff**.
- Human handoff: assign reception team, add a private note, send a
  customer-facing notice, and suppress automatic replies while a human owns the
  conversation.
- Durable state for processed events, handoff status, and pending side effects —
  retries and restarts never create duplicate messages or notes.
- Explicit, verified resume when reception returns the conversation to the bot.

## Requirements

- Docker + Docker Compose v2.
- The official OpenClaw image (`ghcr.io/openclaw/openclaw`). OpenClaw is pinned
  as an optional peer dependency and is **not** installed on the host.
- A reachable Chatwoot instance (SaaS or self-hosted) with an API token and a
  webhook configured to point at this Gateway.

## Install and run (single OpenClaw container)

```bash
cp .env.example .env        # fill in Chatwoot + gateway values
./scripts/test.sh image      # pull the OpenClaw image
docker compose up -d         # start the Gateway (one container)
```

Install and enable the plugin inside the Gateway container:

```bash
docker compose exec openclaw-gateway openclaw plugins install --link /plugin
docker compose exec openclaw-gateway openclaw plugins inspect chatwoot --runtime --json
```

Configure the channel in `openclaw.json` (persisted in the `openclaw-state`
volume) — see [`docs/configuration.md`](docs/configuration.md) for the full
example. The short version:

```json5
{
  channels: {
    chatwoot: {
      baseUrl: "https://app.chatwoot.com",
      accountId: 1,
      apiToken: "your-api-token",
      webhookSecret: "your-webhook-secret",
      receptionTeamId: 1
    }
  }
}
```

Point your Chatwoot webhook at `https://<gateway-host>/chatwoot/webhook`.

By default (`webhookSignatureMode: "chatwoot"`) the plugin verifies Chatwoot's
native webhook signature: set the shared **webhook secret** in the Chatwoot
webhook settings and the plugin verifies `X-Chatwoot-Signature` /
`X-Chatwoot-Timestamp` on every delivery (with a replay window). Deployments that
cannot use native signing (e.g. hosting behind a proxy without header
propagation) can set `webhookSignatureMode: "custom"` and have the ingress put
`HMAC-SHA256(rawBody, secret)` in `webhookHeader` (default
`x-openclaw-signature`).

## Configuration reference

Channel config lives under `channels.chatwoot`. Plugin-level config lives under
`plugins.entries.chatwoot.config`.

| Key | Required | Description |
| --- | --- | --- |
| `baseUrl` | yes | Chatwoot base URL (no trailing slash). |
| `accountId` | yes | Chatwoot account id. |
| `apiToken` | yes | Chatwoot user API access token (`api_access_token`). |
| `webhookSecret` | yes* | Shared secret. Native mode sig (default). |
| `webhookSignatureMode` | no | `chatwoot` (default) or `custom`. |
| `webhookHeader` | no | Signature header, custom mode (default `x-openclaw-signature`). |
| `webhookTimestampToleranceSec` | no | Native-mode replay window (default 300, 0 = off). |
| `webhookPath` | no | Gateway route (default `/chatwoot/webhook`). |
| `receptionTeamId` | no | Team id for human handoff assignment. |
| `fallbackModels` | no | Deprecated (model failover is core-owned via `agents.defaults.model.fallbacks`). |
| `handoffNotice` | no | Customer-facing notice on handoff. |
| `handoffNoteTemplate` | no | Private note template (`{session}`, `{conversation}`, `{reason}`). |
| `maxRetries` | no | Transient retries (default 3). |
| `allowFrom` / `dmSecurity` | no | DM policy for the channel. |

\* `webhookSecret` is required when `webhookSignatureMode` is `chatwoot`
(default) or when using custom mode; inbound webhooks without a valid signature
are rejected with `401`.

## Failure and handoff flow

See [`docs/failure-handoff.md`](docs/failure-handoff.md) for the full state
machine. Summary:

| Failure | Action |
| --- | --- |
| Transient (network/5xx/rate limit) | Bounded retry, then fallback model, then handoff. |
| Quota exhausted | Fallback model immediately; handoff when none remain. |
| Auth / configuration | Operator alert only. Never surfaced to the customer. |
| Outbound delivery | Retry in the client; handoff on terminal failure. |
| Terminal agent error | Handoff to reception. |

Handoff: assign team → private note → customer notice → suppress auto-replies.
Resume only on a verified assignment/status event. Duplicate fallback replies are
suppressed when OpenClaw has already delivered an error response.

## Tests

The suite is mock-first and runs **inside the OpenClaw image** (the host Node
version may be older than OpenClaw requires):

```bash
./scripts/test.sh          # npm install + typecheck + vitest, in-container
./scripts/test.sh shell    # interactive shell in the same image
```

Covered cases: successful inbound/outbound, duplicate webhooks, isolated
conversations, quota exhaustion, transient model errors, fallback-model success,
Chatwoot API failures, duplicate side effects, human takeover, explicit resume,
and recovery after restart.

Chatwoot itself is not deployed: tests use an in-process mock of the Chatwoot
public API and Chatwoot-shaped webhook payloads.

## Layout

```
openclaw.plugin.json        manifest (channels, channelConfigs schema)
index.ts                    plugin entry + webhook HTTP route
setup-entry.ts              lightweight setup entry
src/
  channel.ts                channel plugin (config, security, outbound)
  client.ts                 Chatwoot public API client
  webhook.ts                parse / authenticate / filter events
  routing.ts                deterministic session keys
  handler.ts                inbound orchestration + failure policy
  failure.ts                failure classification
  fallback.ts               fallback-model decisions
  handoff.ts                handoff, suppression, resume
  state.ts                  durable state
  model.ts                  agent outcome normalization
tests/                      vitest mock tests
docker-compose.yml          single OpenClaw Gateway container
scripts/test.sh             in-container test runner
```

## License

MIT
