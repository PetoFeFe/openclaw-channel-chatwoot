# OpenClaw Chatwoot channel plugin

A thin, native [OpenClaw](https://docs.openclaw.ai) channel plugin that connects
OpenClaw to [Chatwoot](https://www.chatwoot.com). It is **inbound only**.

- **Chatwoot owns** conversation history, replies, notes, assignment, and the
  human support workflow.
- **OpenClaw owns** agent execution and model selection.
- The plugin validates and deduplicates Chatwoot webhooks, routes each
  conversation to a deterministic OpenClaw session, and delivers the customer
  message to the agent.
- The **agent owns every Chatwoot action**: replies, private notes, team
  assignment, and status changes. The plugin has no outbound adapter and never
  calls Chatwoot's send/assign APIs.

There is **no n8n**, no separate integration microservice, no plugin-side queue,
and no plugin-side handoff state machine. The separate Help Center MCP server is
untouched (`get_inbox`, `search_kb`, `get_article`).

## Architecture

```
Chatwoot ──webhook──▶ OpenClaw Gateway
                       └─ chatwoot plugin (registerHttpRoute)
                            ├─ verify signature (native X-Chatwoot or custom HMAC)
                            ├─ filter outgoing/private/self/non-message events
                            ├─ dedupe delivery id + Chatwoot message id (durable)
                            ├─ route session chatwoot:<account_id>:<conversation_id>
                            ├─ stage inbound media (voice notes/images)
                            └─ submit customer message to the agent session
                                 └─ agent replies/assigns via Chatwoot CLI/tools
```

The webhook is acknowledged with HTTP 200 as soon as the message is validated
and claimed. The agent turn runs inside the same gateway request scope.

## Features

- Native Chatwoot webhook signature verification, replay window, and optional
  custom HMAC mode.
- Account scoping plus filtering of outgoing, private, self-authored, and
  non-message events.
- Durable deduplication by `X-Chatwoot-Delivery` and Chatwoot message id.
- Deterministic session routing `chatwoot:<account_id>:<conversation_id>`.
- Inbound voice-note/image staging into the OpenClaw media store. The plugin
  never transcribes media; the agent runtime does that during its turn.
- No automatic retry and no automatic human handoff when agent submission
  fails. The failure is logged, the message stays claimed, and the Chatwoot
  conversation is left untouched (`pending`) for a human.

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
      webhookSecret: "your-webhook-secret"
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
| `baseUrl` | yes | Chatwoot base URL (no trailing slash); also resolves inbound attachment URLs. |
| `accountId` | yes | Chatwoot account id. |
| `apiToken` | yes | Chatwoot user API access token. Used only to download private inbound media. |
| `webhookSecret` | yes* | Shared secret. Native mode signature (default). |
| `agentBotWebhookSecret` | no | Second accepted native signature secret (AgentBot deliveries). |
| `webhookSignatureMode` | no | `chatwoot` (default) or `custom`. |
| `webhookHeader` | no | Signature header, custom mode (default `x-openclaw-signature`). |
| `webhookTimestampToleranceSec` | no | Native-mode replay window (default 300, 0 = off). |
| `webhookPath` | no | Gateway route (default `/chatwoot/webhook`). |
| `allowFrom` / `dmSecurity` | no | DM policy for the channel. |

\* `webhookSecret` is required when `webhookSignatureMode` is `chatwoot`
(default) or when using custom mode; inbound webhooks without a valid signature
are rejected with `401`.

| Plugin key | Required | Description |
| --- | --- | --- |
| `stateDir` | no | Durable dedupe state directory. Defaults to `OPENCLAW_CHATWOOT_STATE_DIR` or `<state>/.state`. |

## Inbound behavior

See [`docs/inbound-flow.md`](docs/inbound-flow.md) for the complete sequence.

- Duplicate deliveries and duplicate message ids return `200` without starting
  another agent turn.
- Conversation status is **not** an ingress filter. The live status is passed to
  the agent, which decides whether to reply or stay silent.
- If submitting to the agent fails, the plugin logs the failure and does not
  retry, does not assign a team, does not send a notice, and does not change the
  conversation status.
- Media staging failure passes the original URL through so the agent can still
  attempt to use it.

## Tests

The suite is mock-first and runs **inside the OpenClaw image** (the host Node
version may be older than OpenClaw requires):

```bash
./scripts/test.sh          # npm install + typecheck + vitest, in-container
./scripts/test.sh shell    # interactive shell in the same image
```

Covered cases: inbound dispatch, duplicate webhooks, account isolation,
signature verification/replay rejection, non-message events, dedupe persistence,
and preservation of the claim after a failed dispatch.

## Layout

```
openclaw.plugin.json        manifest (channels, channelConfigs schema)
index.ts                    plugin entry + webhook HTTP route + media staging
setup-entry.ts              lightweight setup entry
src/
  channel.ts                inbound-only channel plugin object
  webhook.ts                parse / authenticate / filter events
  routing.ts                deterministic session keys
  handler.ts                inbound admission + dedupe + dispatch
  state.ts                  durable dedupe state
tests/                      vitest mock tests
docker-compose.yml          single OpenClaw Gateway container
scripts/test.sh             in-container test runner
```

## License

MIT
