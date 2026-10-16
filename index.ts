/**
 * OpenClaw plugin entry point.
 *
 * Registers the Chatwoot channel and the webhook HTTP route that receives
 * Chatwoot events, then drives the shared inbound lifecycle.
 *
 * Inbound dispatch uses the adapter-based `runtime.channel.inbound.run` path
 * (the same surface bundled native channels use). Unlike the convenience
 * `dispatchInboundDirectDmWithRuntime` helper, the adapter path lets the plugin
 * pass an explicit `route.sessionKey`, so each Chatwoot conversation maps to
 * exactly one OpenClaw session:
 *
 *     chatwoot:<account_id>:<conversation_id>
 *
 * Model failover is owned by OpenClaw core (`agents.defaults.model.fallbacks`).
 * This plugin owns transport auth, deduplication, delivery, failure policy, and
 * human handoff; it never picks a model itself.
 */
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { readAgentRunTerminalOutcome } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  chatwootPlugin,
  bindAccountResolver,
  createClient,
  resolveAccount,
  resolveChatwootConfig
} from "./src/channel.js";
import {
  handleConversationEvent,
  handleWebhookEvent,
  recoverPendingEffects,
  type Dispatch,
  type WebhookHandlerDeps
} from "./src/handler.js";
import { DurableState } from "./src/state.js";
import { parseHandoffDirective } from "./src/directive.js";
import { performHandoff } from "./src/handoff.js";
import { extractImageUrls } from "./src/media.js";
import { DEFAULT_WEBHOOK_HEADER, DEFAULT_WEBHOOK_PATH } from "./src/types.js";

type Api = Parameters<NonNullable<Parameters<typeof defineChannelPluginEntry>[0]["registerFull"]>>[0];

const CHANNEL = "chatwoot";

export default defineChannelPluginEntry({
  id: "chatwoot",
  name: "Chatwoot",
  description: "Native OpenClaw channel plugin for Chatwoot",
  plugin: chatwootPlugin,
  registerFull(api: Api) {
    const config = resolveChatwootConfig(api.config);
    const pluginConfig = (api.pluginConfig ?? {}) as { stateDir?: string; timeoutMs?: number };
    const stateDir =
      pluginConfig.stateDir ?? process.env.OPENCLAW_CHATWOOT_STATE_DIR ?? api.resolvePath(".state");
    const state = DurableState.open({ filePath: join(stateDir, "chatwoot-state.json") });
    const client = createClient(config, pluginConfig.timeoutMs);

    // Let the outbound adapter resolve the live client without re-parsing config.
    bindAccountResolver((accountId) => resolveAccount(api.config, accountId));

    // Finish any handoff side effects interrupted by a restart.
    void recoverPendingEffects({ state, client, config, log: api.logger }).catch((error) =>
      api.logger.error?.(`chatwoot: recovery failed: ${(error as Error).message}`)
    );

    const dispatch: Dispatch = async (request) => {
      let dispatchError: unknown;
      let deliveredMessageId: number | undefined;
      // Set when the agent's reply requests a human handoff; the public text is
      // the handoff notice and is sent by performHandoff instead of as a reply.
      let handoffRequest:
        | { teamId?: string; reason?: string; notice: string }
        | undefined;

      // Delivery: core hands us the visible reply; this plugin writes it to
      // Chatwoot and records the confirmed message id as the receipt.
      const deliver = async (payload: OutboundReplyPayload | undefined) => {
        const text =
          typeof payload?.text === "string"
            ? payload.text
            : typeof payload?.fallbackText?.text === "string"
              ? payload.fallbackText.text
              : "";
        if (!text) return;
        // Suppress OpenClaw core's default English waiting/continuation notices
        // emitted when subagents (like Knowledge) yield for completion.
        if (/^I['’]m continuing this work and will send the result when it is ready\.?$/i.test(text.trim())) {
          return;
        }
        const directive = parseHandoffDirective(text);
        if (directive) {
          handoffRequest = {
            teamId: directive.teamId,
            reason: directive.reason,
            notice: directive.notice
          };
          return;
        }
        // Lift Markdown images (e.g. the pricing table from Knowledge) and any
        // SDK-provided media out of the reply so Chatwoot receives a real
        // attachment instead of a dangling "see the image" promise.
        const extracted = extractImageUrls(text);
        const mediaUrls = [
          ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : []),
          ...(typeof payload?.mediaUrl === "string" ? [payload.mediaUrl] : [])
        ].filter((url): url is string => typeof url === "string" && url.trim().length > 0);
        const attachments = [...extracted.images, ...mediaUrls];
        const caption = extracted.text || (attachments.length > 0 ? " " : "");
        if (!caption && attachments.length === 0) return;
        const result = await client.sendMessage({
          conversationId: request.conversationId,
          content: caption,
          attachments
        });
        if (typeof result.messageId === "number") deliveredMessageId = result.messageId;
      };

      // Resolve the agent, then override the session key with the exact
      // per-conversation key. Core stores this as
      // `agent:<agentId>:chatwoot:<accountId>:<conversationId>`.
      const agentRoute = api.runtime.channel.routing.resolveAgentRoute({
        cfg: api.config,
        channel: CHANNEL,
        accountId: request.accountId,
        peer: { kind: "direct", id: request.conversationId }
      });
      // OpenClaw enforces strict multi-agent session ownership: an unscoped
      // session key cannot be resolved to an agent when several are configured.
      // Scope the core-facing session key with the routed agent while keeping
      // the plugin's own (unscoped) key for durable state and Chatwoot calls.
      const coreSessionKey = request.sessionKey.startsWith("agent:")
        ? request.sessionKey
        : `agent:${agentRoute.agentId}:${request.sessionKey}`;
      const route = { agentId: agentRoute.agentId, sessionKey: coreSessionKey };

      const senderAddress = request.senderId ?? request.conversationId;
      const messageSid =
        request.messageId !== undefined
          ? String(request.messageId)
          : `${request.sessionKey}:${Date.now()}`;

      const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
        Body: request.text,
        BodyForAgent: request.text,
        RawBody: request.text,
        CommandBody: request.text,
        From: senderAddress,
        To: `chatwoot:${request.accountId}`,
        SessionKey: coreSessionKey,
        AccountId: request.accountId,
        ChatType: "direct",
        ConversationLabel: request.sessionKey,
        SenderId: request.senderId,
        Provider: CHANNEL,
        Surface: CHANNEL,
        MessageSid: messageSid,
        MessageSidFull: messageSid,
        OriginatingChannel: CHANNEL,
        OriginatingTo: request.sessionKey,
        chatwoot: {
          accountId: request.accountId,
          conversationId: request.conversationId,
          sessionKey: request.sessionKey
        }
      });

      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: api.config,
        agentId: route.agentId,
        channel: CHANNEL,
        accountId: request.accountId
      });

      let turnResult;
      try {
        turnResult = await api.runtime.channel.inbound.run({
          channel: CHANNEL,
          accountId: request.accountId,
          raw: ctxPayload,
          adapter: {
            ingest: () => ({
              id: messageSid,
              rawText: request.text,
              raw: ctxPayload
            }),
            resolveTurn: () => ({
              cfg: api.config,
              channel: CHANNEL,
              accountId: request.accountId,
              route,
              ctxPayload,
              record: {
                onRecordError: (error) => {
                  dispatchError ??= error;
                  api.logger.warn?.(`chatwoot: inbound record error: ${describe(error)}`);
                }
              },
              delivery: {
                deliver,
                onError: (error) => {
                  dispatchError = error;
                  api.logger.warn?.(`chatwoot: agent dispatch error: ${describe(error)}`);
                }
              },
              replyPipeline,
              replyOptions: { onModelSelected }
            })
          }
        });
      } catch (error) {
        dispatchError = error;
        api.logger.warn?.(`chatwoot: inbound.run threw: ${describe(error)}`);
      }

      const terminalOutcome = turnResult?.dispatched
        ? readAgentRunTerminalOutcome(turnResult.dispatchResult)
        : undefined;
      if (terminalOutcome === "failed" && turnResult?.dispatched) {
        const dr = turnResult.dispatchResult as unknown as Record<symbol, unknown>;
        const terminalError = dr[Symbol.for("openclaw.agentRunTerminalError")];
        api.logger.warn?.(
          `chatwoot: agent run failed detail: ${describe(terminalError)}`
        );
      }

      const delivered = deliveredMessageId !== undefined;
      if (dispatchError) {
        // Never expose internals to the customer; classifyError owns the
        // customer-safe text. deliveredTerminalError prevents a duplicate
        // handoff notice when OpenClaw already delivered something.
        return {
          ok: false,
          error: dispatchError,
          deliveredMessageId,
          delivered,
          deliveredTerminalError: delivered
        };
      }
      if (terminalOutcome === "failed") {
        return {
          ok: false,
          error: new Error("agent run reported a terminal failure"),
          deliveredMessageId,
          delivered,
          deliveredTerminalError: delivered
        };
      }
      // Agent-requested handoff (business policy): assign the requested team,
      // post the private note, and deliver the agent-authored notice. This runs
      // instead of a normal reply; `deliveredMessageId` reflects the notice.
      if (handoffRequest) {
        try {
          const targetTeamId = resolveHandoffTeam(handoffRequest.teamId, config);
          await performHandoff({
            client,
            state,
            config,
            conversationId: request.conversationId,
            convKey: request.sessionKey,
            teamId: targetTeamId,
            reason: handoffRequest.reason ?? "agent-requested",
            noticeText: handoffRequest.notice,
            log: api.logger
          });
        } catch (error) {
          dispatchError = error;
          return {
            ok: false,
            error,
            deliveredMessageId,
            delivered,
            deliveredTerminalError: delivered
          };
        }
      }
      if (terminalOutcome === "completed" && !delivered && !handoffRequest) {
        // Explicit completion with no visible reply: a silent turn.
        return { ok: true, deliveredMessageId, delivered: false };
      }
      // A missing terminal marker means the run completed without recording a
      // terminal outcome (older behaviour); treat a missing receipt as silence.
      return { ok: true, deliveredMessageId, delivered };
    };

    const deps: WebhookHandlerDeps = {
      config,
      state,
      client,
      dispatch,
      log: api.logger,
      onOperatorAlert: (info) =>
        api.logger.error?.(`chatwoot: operator alert [${info.class}] ${info.detail}`)
    };

    const webhookPath = config.webhookPath ?? DEFAULT_WEBHOOK_PATH;
    const customHeaderName = (config.webhookHeader ?? DEFAULT_WEBHOOK_HEADER).toLowerCase();

    api.registerHttpRoute({
      path: webhookPath,
      auth: "plugin",
      handler: async (req, res) => {
        const rawBody = await readRequestBody(req);
        const signatureHeader = firstHeader(req, "x-chatwoot-signature") ?? firstHeader(req, customHeaderName);
        const timestampHeader = firstHeader(req, "x-chatwoot-timestamp");
        const deliveryId = firstHeader(req, "x-chatwoot-delivery");

        const event = safeParseEvent(rawBody);
        const isConversationEvent =
          typeof event === "string" &&
          (event === "conversation_updated" ||
            event === "conversation_status_changed" ||
            event === "conversation_created");

        const eventDeps: WebhookHandlerDeps = {
          ...deps,
          signatureHeader,
          timestampHeader,
          deliveryId
        };

        const result = isConversationEvent
          ? await handleConversationEvent(rawBody, eventDeps)
          : await handleWebhookEvent(rawBody, eventDeps);

        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ ok: result.status < 300, action: result.action, reason: result.reason })
        );
        return true;
      }
    });
  }
});

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Resolve the team id for an agent-requested handoff.
 *
 * Only teams the deployment knows about are accepted (reception / administration
 * or an explicit numeric id), so a malformed or prompt-injected directive cannot
 * assign the conversation to an arbitrary team. Unknown/missing values fall back
 * to the reception team (Level 1).
 */
function resolveHandoffTeam(
  requested: string | undefined,
  config: { receptionTeamId?: string | number; administrationTeamId?: string | number }
): string | number | undefined {
  const value = requested?.trim();
  if (!value) return config.receptionTeamId;
  const known = [config.receptionTeamId, config.administrationTeamId]
    .filter((team): team is string | number => team !== undefined && team !== null)
    .map(String);
  if (known.includes(value)) return value;
  // Unknown team: fall back to reception rather than trusting arbitrary input.
  return config.receptionTeamId;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeParseEvent(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as { event?: unknown };
    return typeof parsed?.event === "string" ? parsed.event : undefined;
  } catch {
    return undefined;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
