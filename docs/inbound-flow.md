# Inbound flow

The plugin is a one-way adapter from Chatwoot into OpenClaw. It never posts a
message, private note, assignment, or status change back to Chatwoot.

## Sequence

1. **Receive** `POST /chatwoot/webhook` (path configurable).
2. **Authenticate** the raw body:
   - native mode: `X-Chatwoot-Timestamp` + `X-Chatwoot-Signature`;
   - custom mode: HMAC-SHA256 of the raw body in `webhookHeader`;
   - either the account webhook secret or the AgentBot secret is accepted.
3. **Claim** `X-Chatwoot-Delivery` in durable state when present. A replay
   returns `200 duplicate` and performs no work.
4. **Parse and classify** the event:
   - only `message_created` and `message_updated` can dispatch;
   - outgoing, private, self-authored, and empty messages are ignored;
   - account id must match `channels.chatwoot.accountId`.
5. **Claim** `msg:<account>:<message id>` in durable state. A duplicate returns
   `200 duplicate` and performs no work.
6. **Respond 200** to Chatwoot.
7. **Build the inbound context**:
   - deterministic session `chatwoot:<account>:<conversation>`;
   - live conversation status included in the prompt;
   - audio/image attachments staged into the OpenClaw media store when possible.
8. **Submit** the message to the OpenClaw session through
   `sessions.send` (creating the session first if needed).

The agent decides whether to answer based on the live status and its
instructions. On AgentBot inboxes, `pending` normally means the bot owns the
conversation; `open`/`snoozed` normally means a human owns it. That policy lives
in the agent, not in the plugin.

## Failure behavior

Submission failures are terminal for that webhook:

- no retry;
- no automatic handoff, team assignment, private note, or customer notice;
- no conversation status change;
- the message id stays claimed, so a Chatwoot redelivery cannot start a second
  agent turn;
- the failure is logged by the Gateway;
- the conversation is left as it was (normally `pending`) for a human to pick up.

If the inbound media download fails, the attachment's remote URL is passed to
the agent instead of dropping the message.

## State

`chatwoot-state.json` contains only processed keys:

```json
{
  "processed": {
    "delivery:abc-123": "2026-10-23T12:00:00.000Z",
    "msg:3:1234": "2026-10-23T12:00:01.000Z"
  }
}
```

Legacy `handoffs` and `effects` keys from older plugin versions are ignored and
dropped on the next write.
