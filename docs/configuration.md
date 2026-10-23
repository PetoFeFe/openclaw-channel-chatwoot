# Configuration

## Channel: `channels.chatwoot`

```json5
{
  channels: {
    chatwoot: {
      baseUrl: "https://app.chatwoot.com",
      accountId: 1,
      apiToken: "your-chatwoot-user-api-token",
      webhookSecret: "your-webhook-secret",
      webhookSignatureMode: "chatwoot",      // or "custom"
      webhookHeader: "x-openclaw-signature", // custom mode only
      webhookTimestampToleranceSec: 300,
      webhookPath: "/chatwoot/webhook",
      dmSecurity: "open",
      allowFrom: []
    }
  }
}
```

Required: `baseUrl`, `accountId`, `apiToken`. `webhookSecret` is needed for
signature verification in both modes (webhooks without a valid signature are
rejected with `401`). `allowFrom` / `dmSecurity` are optional DM policy knobs;
the Chatwoot channel is a trusted gate, so the default is an open DM policy.

`apiToken` is used only to download private inbound attachments (voice notes and
images). It is never used to send messages or change conversations.

## Plugin: `plugins.entries.chatwoot`

```json5
{
  plugins: {
    entries: {
      chatwoot: {
        enabled: true,
        config: {
          stateDir: "/home/node/.openclaw/plugin-state/chatwoot"
        }
      }
    }
  }
}
```

`stateDir` holds the durable dedupe file (`chatwoot-state.json`). When omitted,
the plugin uses `OPENCLAW_CHATWOOT_STATE_DIR` or `<OpenClaw state>/.state`.

## Chatwoot side

1. Create a **user** and generate an **API access token** (Profile → Access
   token). Put it in `apiToken`.
2. Add a **webhook** (Settings → Integrations → Webhooks) pointing at
   `https://<gateway-host>/chatwoot/webhook`, subscribed to at least
   `message_created` and `message_updated`. Conversation events are accepted but
   ignored by the plugin.
3. Set the webhook **secret** in the Chatwoot webhook settings. The plugin
   verifies Chatwoot's native signature (`X-Chatwoot-Signature` +
   `X-Chatwoot-Timestamp`, HMAC-SHA256 of `"{timestamp}.{raw_body}"`) with a
   configurable replay window. If your ingress cannot forward Chatwoot's headers,
   set `webhookSignatureMode: "custom"` and add
   `x-openclaw-signature: <hex HMAC SHA256(rawBody, secret)>` at the edge.
4. No team ids or handoff settings are needed by the plugin. The agent owns all
   assignment and reply behavior.

## Deploying with a single OpenClaw container

```bash
cp .env.example .env
./scripts/test.sh image
docker compose up -d
docker compose exec openclaw-gateway openclaw plugins install --link /plugin
docker compose exec openclaw-gateway openclaw plugins inspect chatwoot --runtime --json
```

The compose file mounts this repository at `/plugin` (writable so the test
runner can install dev dependencies) and persists OpenClaw state in the
`openclaw-state` named volume.
