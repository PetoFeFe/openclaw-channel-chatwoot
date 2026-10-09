# Failure and handoff flow

This document describes exactly how the Chatwoot plugin behaves when an agent
run cannot be completed, and how human handoff and resume work.

## Failure classes

Failures are classified in `src/failure.ts`:

| Class | Trigger | Retryable | Customer sees |
| --- | --- | --- | --- |
| `transient` | network errors, timeouts, HTTP 5xx, rate limiting (429 without a quota code) | yes | nothing (handled internally) |
| `quota` | `insufficient_quota`, `quota_exceeded`, billing hard limit | no | nothing |
| `auth` | HTTP 401/403, invalid API token, configuration errors | no | nothing |
| `delivery` | outbound Chatwoot send failed | partial | generic notice on handoff |
| `terminal` | unrecoverable agent error | no | generic notice on handoff |
| `unknown` | anything else | no | generic notice on handoff |

Internal provider errors are **never** included in customer-visible messages.
Only the generic `delivery`/`terminal` message is used, and only as part of a
handoff.

## Decision policy

`src/fallback.ts` turns a failure class into an action:

```text
quota      -> fallback model (if any remain) -> else handoff
transient  -> retry (bounded by maxRetries)  -> fallback model -> handoff
auth       -> operator alert (no customer message)
delivery   -> handoff
terminal   -> handoff
```

Fallback models are tried in the order given by `fallbackModels`, never
repeating one. If OpenClaw has already delivered a terminal error response to
the customer, the plugin suppresses its own customer-facing notice to avoid
duplicate fallback replies (`shouldSuppressFallbackReply`).

## Handoff sequence

Implemented idempotently in `src/handoff.ts`:

1. **Mark handoff active** (durable) — from this point inbound messages are
   suppressed and not dispatched to the agent.
2. **Assign reception team** — `POST .../conversations/{id}/assignments`. Before
   assigning, the current conversation is read so a restart does not duplicate
   the assignment.
3. **Private note** — a private message containing a deterministic marker
   `<!-- openclaw-handoff:<convKey> --> kind=note`.
4. **Customer notice** — a public message with marker `... kind=notice`
   (skipped when OpenClaw already replied).

Each step is recorded as a pending effect before it runs and deleted after it
succeeds. Notes and notices carry the marker, so even if the process crashes and
the durable state is lost, a retry compares existing conversation messages and
does not resend.

## Auto-reply suppression

While `handoff.active === true` for a conversation:

- inbound `message_created` events are acknowledged (`200`) but not dispatched
  (`action: "suppressed-handoff"`),
- the agent never runs,
- no outbound reply is produced.

## Explicit, verified resume

`handleConversationEvent` handles `conversation_updated`,
`conversation_status_changed`, and `conversation_created` events. A handoff is
resumed only on a verified signal that reception has returned the conversation
to the bot:

- `team_id` is present and differs from `receptionTeamId`, or
- `team_id` is cleared (`null`), or
- the conversation status is `resolved`.

While reception still owns the conversation (`team_id === receptionTeamId`), the
event is ignored (`reason: "handoff-still-active"`). On resume the handoff record
is marked inactive and automatic replies are re-enabled; the next customer
message is dispatched normally.

## Restart recovery

On plugin load, `recoverPendingEffects` scans durable state for conversations
with pending effects and completes the handoff idempotently. Combined with the
message markers, a restart cannot create duplicate notes or notices.

## State

Durable state (`src/state.ts`) is an atomically written JSON file (temp file +
rename) in `plugins.entries.chatwoot.config.stateDir` (or
`OPENCLAW_CHATWOOT_STATE_DIR`):

```json
{
  "processed": { "msg:1:1234": "2026-10-09T12:00:00.000Z" },
  "handoffs": {
    "chatwoot:1:42": { "active": true, "teamId": "5", "reason": "quota", "updatedAt": "...", "noteSent": true, "customerNoticeSent": true }
  },
  "effects": {}
}
```

- `processed` deduplicates webhook delivery.
- `handoffs` drives suppression and resume.
- `effects` tracks in-flight side effects so retries are safe.
