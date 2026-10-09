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
        const result = await client.sendMessage({
          conversationId: request.conversationId,
          content: text
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
      const route = { agentId: agentRoute.agentId, sessionKey: request.sessionKey };

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
        SessionKey: request.sessionKey,
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
                  api.logger.error?.(`chatwoot: inbound record error: ${describe(error)}`);
                }
              },
              delivery: {
                deliver,
                onError: (error) => {
                  dispatchError = error;
                  api.logger.error?.(`chatwoot: agent dispatch error: ${describe(error)}`);
                }
              },
              replyPipeline,
              replyOptions: { onModelSelected }
            })
          }
        });
      } catch (error) {
        dispatchError = error;
      }

      const terminalOutcome = turnResult?.dispatched
        ? readAgentRunTerminalOutcome(turnResult.dispatchResult)
        : undefined;

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
      if (terminalOutcome === "completed" && !delivered) {
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
