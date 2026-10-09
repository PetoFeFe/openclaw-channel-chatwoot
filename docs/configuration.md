# Configuration

## Channel: `channels.chatwoot`

```json5
{
  channels: {
    chatwoot: {
      baseUrl: "https://app.chatwoot.com",
      accountId: 1,
      apiToken: { fromEnv: "CHATWOOT_API_TOKEN" },
      webhookSecret: { fromEnv: "CHATWOOT_WEBHOOK_SECRET" },
      webhookHeader: "x-openclaw-signature",
      webhookPath: "/chatwoot/webhook",
      receptionTeamId: 1,
      receptionTeamName: "Reception",
      fallbackModels: ["gpt-4o-mini", "gpt-4.1-mini"],
      handoffNotice: "I'm connecting you with a member of our team.",
      handoffNoteTemplate: "OpenClaw handed this conversation off. Reason: {reason}",
      maxRetries: 3,
      dmSecurity: "allowlist",
      allowFrom: []
    }
  }
}
```

## Plugin: `plugins.entries.chatwoot`

```json5
{
  plugins: {
    entries: {
      chatwoot: {
        enabled: true,
        config: {
          stateDir: "/home/node/.openclaw/plugin-state/chatwoot",
          timeoutMs: 15000
        }
      }
    }
  }
}
```

## Chatwoot side

1. Create a **user** and generate an **API access token** (Profile → Access
   token). Put it in `CHATWOOT_API_TOKEN`.
2. Add a **webhook** (Settings → Integrations → Webhooks) pointing at
   `https://<gateway-host>/chatwoot/webhook`, subscribed to at least
   `message_created`, `conversation_updated`, and `conversation_status_changed`.
3. Chatwoot does not sign webhooks. Set `webhookSecret` and have your ingress
   add `x-openclaw-signature: <hex HMAC-SHA256 of the raw body>`, or place the
   route behind a trusted proxy.
4. Create the reception **team** and note its id for `receptionTeamId`.

## Deploying with a single OpenClaw container

```bash
cp .env.example .env
./scripts/test.sh image
docker compose up -d
docker compose exec openclaw-gateway node dist/index.js plugins install --link /plugin
docker compose exec openclaw-gateway node dist/index.js plugins inspect chatwoot --runtime --json
```

The compose file mounts this repository read-only at `/plugin` and persists
OpenClaw state in the `openclaw-state` named volume.
