# Verified interfaces

This document pins the external contracts the plugin is built against. It is the
single source of truth for "we checked this", so a future upgrade can diff
against it.

- **OpenClaw**: `openclaw@2026.9.9` (image `ghcr.io/openclaw/openclaw`, Node
  `24.21.0`). SDK subpaths are imported only from `openclaw/plugin-sdk/*`.
- **Chatwoot**: native signed webhooks and private ActiveStorage media URLs
  (documented under `developers.chatwoot.com`). No Chatwoot source internals are
  used.
- **Reference channel**: bundled `@openclaw/whatsapp@2026.9.9` for the
  inbound-pattern and media staging references.

## OpenClaw plugin SDK (2026.9.9)

### Entrypoints

| Symbol | Subpath | Notes |
| --- | --- | --- |
| `defineChannelPluginEntry(opts)` | `openclaw/plugin-sdk/channel-core` | `opts` includes `id`, `name`, `description`, `plugin`, `registerCapabilities(api)`, `registerFull(api)`. |
| `defineSetupPluginEntry(plugin)` | `openclaw/plugin-sdk/channel-core` | Lightweight setup entry. |
| `createChatChannelPlugin(opts)` | `openclaw/plugin-sdk/channel-core` | `base` and `security` are used. `outbound` is optional and intentionally omitted. |
| `createChannelPluginBase(opts)` | `openclaw/plugin-sdk/channel-core` | `id`, `config.{listAccountIds,resolveAccount,inspectAccount}`, `setup.applyAccountConfig`. |
| `OpenClawConfig` | `openclaw/plugin-sdk/channel-core` | Type-only import. |

### `registerFull(api)` surface used

| Member | Signature (verified) |
| --- | --- |
| `api.config` | `OpenClawConfig` |
| `api.pluginConfig` | plugin config under `plugins.entries.<id>.config` |
| `api.resolvePath(rel)` | resolves a path under the OpenClaw state dir |
| `api.logger` | `{ info?, warn?, error?, debug? }(message, meta?)` |
| `api.registerHttpRoute` | `{ path, auth, handler, match?, replaceExisting? }`; `auth: "plugin"` means the plugin owns auth. |
| `api.runtime` | `PluginRuntime` (see below) |

### Runtime surface for inbound dispatch

| Member | Verified behavior |
| --- | --- |
| `api.runtime.channel.routing.resolveAgentRoute({cfg,channel,accountId,peer})` | returns a route with `agentId` and a derived `sessionKey`. Used only to obtain `agentId`. |
| `api.runtime.channel.reply.finalizeInboundContext(ctx)` | finalizes the prompt/session context; reachable through the injected runtime. |
| `callGatewayFromCli("sessions.send", {}, {key,message,idempotencyKey})` | `openclaw/plugin-sdk/gateway-runtime`; submits a turn to an existing session. |
| `callGatewayFromCli("sessions.create", {}, {key})` | creates the session when `sessions.send` reports `session not found`. |

### Media staging

| Symbol | Subpath | Notes |
| --- | --- | --- |
| `saveMediaBuffer(buffer, contentType, channel, maxBytes, filename)` | `openclaw/plugin-sdk/media-runtime` | Persists inbound bytes into the OpenClaw media store. |
| `transcribeOpenAiCompatibleAudio(req)` | `openclaw/plugin-sdk/media-understanding` | Registers the deployment LLM Gateway as an audio provider; transcription itself happens in the agent runtime. |

## Chatwoot native webhooks (verified)

Signed deliveries include:

- `X-Chatwoot-Timestamp` — Unix timestamp (seconds).
- `X-Chatwoot-Signature` — `sha256=` + `HMAC_SHA256(secret, "{timestamp}.{raw_request_body}")`, lowercase hex.
- `X-Chatwoot-Delivery` — delivery id, present when available.

Verification rules implemented by the plugin:

1. constant-time compare of the full `sha256=<hex>` value;
2. replay window: reject when `|now - timestamp| > tolerance` (default 300s);
3. optional `X-Chatwoot-Delivery` dedupe in addition to message-id dedupe.

Subscriptions: the plugin needs `message_created` and `message_updated`.
Conversation/contact events may be delivered but are classified as
`event-not-message` and ignored.

### Message payload shape (verified)

```jsonc
{
  "event": "message_created",
  "id": 1234,
  "content": "hello",
  "message_type": "incoming",          // incoming | outgoing | template
  "content_type": "text",
  "private": false,
  "sender": { "id": 42, "type": "contact", "name": "…" },
  "conversation": { "id": 7, "status": "open", "team_id": null, "inbox_id": 1 },
  "account": { "id": 1 },
  "inbox": { "id": 1 },
  "attachments": [
    { "id": 9, "file_type": "audio", "data_url": "https://…/blob", "content_type": "audio/ogg" }
  ]
}
```

Nested/push payloads may place the triggering message under
`conversation.messages[0]`; the parser accepts both shapes.

## Chatwoot media access (verified)

Private ActiveStorage attachments are downloadable with the configured user
token in the `api-access-token` header. The plugin only performs `GET` requests
for attachment bytes. It never calls Chatwoot's message, assignment, or
conversation-state endpoints.
