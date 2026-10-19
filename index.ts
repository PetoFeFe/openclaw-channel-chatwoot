/**
 * OpenClaw native Chatwoot channel plugin (simplified).
 *
 * Minimal inbound adapter:
 *   1. Verifies HMAC signature on incoming webhooks (401 on bad signature).
 *   2. Deduplicates incoming messages via durable state.
 *   3. Filters account scope and incoming/private message flags.
 *   4. Acknowledges HTTP 200 immediately to Chatwoot so webhooks never time out.
 *   5. Runs the agent turn inside the handler, serialized and coalesced per
 *      conversation by a lane so a message burst never starts two turns.
 *
 * The agent itself (Tata) owns reading Help Center articles and posting
 * replies back to Chatwoot using the Chatwoot CLI/tools. The plugin never
 * sends messages to Chatwoot.
 */
import { join } from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  chatwootPlugin,
  bindAccountResolver,
  resolveAccount,
  resolveChatwootConfig
} from "./src/channel.js";
import {
  dispatchAdmitted,
  handleConversationEvent,
  prepareInboundAck,
  type Dispatch,
  type WebhookHandlerDeps
} from "./src/handler.js";
import { DurableState } from "./src/state.js";
import { DEFAULT_WEBHOOK_HEADER, DEFAULT_WEBHOOK_PATH } from "./src/types.js";
import { ConversationLanes } from "./src/queue.js";

type Api = Parameters<NonNullable<Parameters<typeof defineChannelPluginEntry>[0]["registerFull"]>>[0];

const CHANNEL = "chatwoot";

export default defineChannelPluginEntry({
  id: "chatwoot",
  name: "Chatwoot",
  description: "Native OpenClaw channel plugin for Chatwoot (inbound adapter)",
  plugin: chatwootPlugin,
  registerFull(api: Api) {
    const config = resolveChatwootConfig(api.config);
    const pluginConfig = (api.pluginConfig ?? {}) as {
      stateDir?: string;
      timeoutMs?: number;
      settleMs?: number;
      dispatchRetries?: number;
    };
    const stateDir =
      pluginConfig.stateDir ?? process.env.OPENCLAW_CHATWOOT_STATE_DIR ?? api.resolvePath(".state");
    const state = DurableState.open({ filePath: join(stateDir, "chatwoot-state.json") });

    // Allow account resolution
    bindAccountResolver((accountId) => resolveAccount(api.config, accountId));

    const dispatch: Dispatch = async (request) => {
      // Resolve the routed agent for this conversation
      const agentRoute = api.runtime.channel.routing.resolveAgentRoute({
        cfg: api.config,
        channel: CHANNEL,
        accountId: request.accountId,
        peer: { kind: "direct", id: request.conversationId }
      });

      const coreSessionKey = request.sessionKey.startsWith("agent:")
        ? request.sessionKey
        : `agent:${agentRoute.agentId}:${request.sessionKey}`;
      const route = { agentId: agentRoute.agentId, sessionKey: coreSessionKey };

      const senderAddress = request.senderId ?? request.conversationId;
      const messageSid =
        request.messageId !== undefined
          ? String(request.messageId)
          : `${request.sessionKey}:${Date.now()}`;

      // Inbound context: provide clear conversation details to the agent
      const promptText = `[Chatwoot Conversation ${request.conversationId} | Account ${request.accountId}]
Customer: ${request.text}`;

      const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
        Body: promptText,
        BodyForAgent: promptText,
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

      // No-op deliverer: the agent delivers replies itself
      const deliver = async () => {};

      await api.runtime.channel.inbound.run({
        channel: CHANNEL,
        accountId: request.accountId,
        raw: ctxPayload,
        adapter: {
          ingest: () => ({
            id: messageSid,
            rawText: promptText,
            raw: ctxPayload
          }),
          resolveTurn: () => ({
            cfg: api.config,
            channel: CHANNEL,
            accountId: request.accountId,
            route,
            ctxPayload,
            record: { onRecordError: () => {} },
            delivery: { deliver, onError: () => {} }
          })
        }
      });

      return { ok: true };
    };

    const lanes = new ConversationLanes({
      dispatch,
      settleMs: pluginConfig.settleMs,
      dispatchRetries: pluginConfig.dispatchRetries,
      log: api.logger
    });

    const deps: WebhookHandlerDeps = {
      config,
      state,
      dispatch,
      lanes,
      log: api.logger
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

        if (isConversationEvent) {
          const result = await handleConversationEvent(rawBody, eventDeps);
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: result.status === 200, action: result.action, reason: result.reason }));
          return;
        }

        // 1. Prepare and validate the ack
        const ack = await prepareInboundAck(rawBody, eventDeps);

        // 2. Respond immediately to Chatwoot (<10ms) so Chatwoot never times out!
        res.statusCode = ack.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: ack.status === 200, action: ack.action, reason: ack.reason }));

        // 3. Run the agent turn inside this handler so the Gateway root task
        //    stays admitted for the whole run. The lane serializes + coalesces
        //    turns per conversation so bursts never start concurrent turns.
        if (ack.action === "dispatched" && ack.request) {
          await dispatchAdmitted(ack.request, eventDeps);
        }
      }
    });
  }
});

function firstHeader(req: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const val = req.headers[name];
  if (Array.isArray(val)) return val[0];
  return val;
}

function safeParseEvent(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw);
    return typeof obj?.event === "string" ? obj.event : undefined;
  } catch {
    return undefined;
  }
}

async function readRequestBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}