# Verified interfaces

This document pins the external contracts the plugin is built against. It is the
single source of truth for "we checked this", so a future upgrade can diff
against it. Everything here was verified against the versions below; nothing in
the plugin relies on undocumented internals.

- **OpenClaw**: `openclaw@2026.9.9` (image `ghcr.io/openclaw/openclaw`, Node
  `24.21.0`). SDK subpaths are imported only from `openclaw/plugin-sdk/*`.
- **Chatwoot**: public API v1 and native signed webhooks (documented under
  `developers.chatwoot.com`). No Chatwoot source internals are used.
- **Reference channel**: bundled `@openclaw/whatsapp@2026.9.9` for the
  adapter-based inbound pattern.

## OpenClaw plugin SDK (2026.9.9)

### Entrypoints

| Symbol | Subpath | Notes |
| --- | --- | --- |
| `defineChannelPluginEntry(opts)` | `openclaw/plugin-sdk/channel-core` | `opts` includes `id`, `name`, `description`, `plugin`, `configSchema`, `registerFull(api)`, `registerCliMetadata`. |
| `defineSetupPluginEntry(plugin)` | `openclaw/plugin-sdk/channel-core` | Lightweight setup entry. |
| `createChatChannelPlugin(opts)` | `openclaw/plugin-sdk/channel-core` | `base`, `security.dm`, `pairing`, `threading`, `outbound`. |
| `createChannelPluginBase(opts)` | `openclaw/plugin-sdk/channel-core` | `id`, `config.{listAccountIds,resolveAccount,inspectAccount}`, `setup.applyAccountConfig`. |
| `OpenClawConfig` | `openclaw/plugin-sdk/channel-core` | Type-only import. |

### `registerFull(api)` surface used

| Member | Signature (verified) |
| --- | --- |
| `api.config` | `OpenClawConfig` |
| `api.pluginConfig` | plugin config under `plugins.entries.<id>.config` |
| `api.resolvePath(rel)` | resolves a path under the OpenClaw state dir |
| `api.logger` | `{ info?, warn?, error?, debug? }(message, meta?)` |
| `api.registerHttpRoute` | `{ path, auth, handler, match?, replaceExisting? }`; `auth: "plugin"` means the plugin owns auth. Handler returns `boolean`. |
| `api.runtime` | `PluginRuntime` (see below) |

### Runtime surface for inbound dispatch

| Member | Verified behavior |
| --- | --- |
| `api.runtime.channel.routing.resolveAgentRoute({cfg,channel,accountId,peer})` | returns a route with `agentId` and a derived `sessionKey`. Used only to obtain `agentId`. |
| `api.runtime.channel.reply.finalizeInboundContext(ctx)` | finalizes the prompt/session context; documented as reachable through the injected runtime. |
| `api.runtime.channel.inbound.run(params)` | alias of `runChannelTurn`. Params: `{channel, accountId?, raw, adapter, log?, turnAdoptionLifecycle?}`. |
| `readAgentRunTerminalOutcome(result)` | `openclaw/plugin-sdk/channel-inbound`; returns `"completed" \| "failed" \| undefined`. |

### Channel turn types (verified)

```ts
type ChannelTurnRoute = { agentId: string; dmScope?: DmScope; sessionKey: string };

type ChannelTurnResult<TDispatchResult> =
  | { admission: {kind:"dispatch"|"observeOnly"}; dispatched: true;
      ctxPayload: MsgContext; routeSessionKey: string; dispatchResult: TDispatchResult }
  | { admission: ChannelTurnAdmission; dispatched: false;
      ctxPayload?: MsgContext; routeSessionKey?: string };

type ChannelTurnAdapter<TRaw, TDispatchResult, TDelivery> = {
  ingest: (raw: TRaw) => NormalizedTurnInput | null | Promise<...>;
  classify?: ...;
  preflight?: ...;
  resolveTurn: (input, eventClass, preflight) => ChannelTurnResolved<...>;
  onFinalize?: (result: ChannelTurnResult<...>) => void | Promise<void>;
};
```

A `resolveTurn` result may be a `ChannelTurnPlan` (`RoutedChannelTurn<...>`): it
carries `route: {agentId, sessionKey}` and replaces the default session wiring.
**This is how the plugin sets the exact session key.**

### Session key derivation (verified)

- The default `cfg.session.dmScope` (typically `"main"`) collapses direct
  messages into one shared session. The convenience helper
  `dispatchInboundDirectDmWithRuntime` derives its session key from
  `resolveChannelInboundRouteEnvelope`/`resolveAgentRoute` and **cannot** be
  given an explicit key.
- Core stores an explicit `route.sessionKey` (e.g. `chatwoot:1:42`) as the agent
  store key `agent:<agentId>:chatwoot:1:42`.
- Therefore the plugin builds its own turn plan and passes the exact key. It
  does **not** use `dispatchInboundDirectDmWithRuntime`.

### `createChannelReplyPipeline` (verified)

`openclaw/plugin-sdk/channel-reply-pipeline` exports
`createChannelReplyPipeline({cfg, agentId, channel, accountId})`, returning
`{ onModelSelected, ...replyPipeline }`. The `replyPipeline` rest is spread into
the turn plan; `onModelSelected` goes in `replyOptions`.

### Outbound (verified)

`createChatChannelPlugin({ outbound: { attachedResults: { channel, sendText, sendMedia }, base } })`.
`sendText(ctx)` receives `{cfg, to, text, accountId?}` and returns
`OutboundDeliveryResult` with `channel` and `messageId: string`. `sendMedia`
receives media fields. `OutboundReplyPayload` supports `text`,
`fallbackText.text`, and `mediaUrls`.

## Chatwoot native webhooks (verified)

Signed deliveries include (source: Chatwoot OpenAPI `webhook.secret`):

- `X-Chatwoot-Timestamp` — Unix timestamp (seconds).
- `X-Chatwoot-Signature` — `sha256=` + `HMAC_SHA256(secret, "{timestamp}.{raw_request_body}")`, lowercase hex.
- `X-Chatwoot-Delivery` — delivery id, present when available.

Verification rules implemented by the plugin:

1. constant-time compare of the full `sha256=<hex>` value;
2. replay window: reject when `|now - timestamp| > tolerance` (default 300s);
3. optional `X-Chatwoot-Delivery` dedupe in addition to message-id dedupe.

Subscriptions: `conversation_created`, `conversation_status_changed`,
`conversation_updated`, `message_created`, `message_updated` (also
`contact_*`, `webwidget_triggered`, `conversation_typing_*`).

Order/time headers used for tolerance checks: `X-Chatwoot-Timestamp`.

### Payload shapes (verified)

`message_created` (and `message_updated`) are nested:

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
  "inbox": { "id": 1 }
}
```

`conversation_*` events are **flat** (not nested under `conversation`):

```jsonc
{
  "event": "conversation_updated",
  "id": 7,
  "status": "open",
  "team_id": 5,
  "changed_attributes": { "team_id": [null, 5] },
  "account": { "id": 1 }
}
```

The parser accepts both flat and (defensively) nested conversation shapes.

## Chatwoot public API v1 (verified)

Base: `{baseUrl}/api/v1/accounts/{account_id}`.

| Operation | Method + path | Body | Response |
| --- | --- | --- | --- |
| Send message / note | `POST /conversations/{id}/messages` | `{content, message_type:"outgoing", private, content_type}` | message object incl. `id` |
| Assign team | `POST /conversations/{id}/assignments` | `{team_id}` | conversation |
| List messages | `GET /conversations/{id}/messages` | — | `{meta, payload: [...]}` |
| Get conversation | `GET /conversations/{id}` | — | conversation incl. `team_id` |

Auth: `api_access_token: <token>` header (deprecated) or
`Authorization: Bearer <token>` (v4.19.0+). The plugin uses
`api_access_token` for maximum compatibility; Bearer support is a documented
future migration.

A confirmed message `id` in the send response is the delivery receipt. Agent-bot
tokens can be scope-restricted; a denied team assignment is treated as a
delivery/auth failure and never surfaced to the customer.
