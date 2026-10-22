/**
 * OpenClaw native Chatwoot channel plugin (simplified).
 *
 * Minimal inbound adapter:
 *   1. Verifies HMAC signature on incoming webhooks (401 on bad signature).
 *   2. Deduplicates incoming messages via durable state.
 *   3. Filters account scope and incoming/private message flags.
 *   4. Acknowledges HTTP 200 immediately to Chatwoot so webhooks never time out.
 *   5. Dispatches the agent turn through the durable spool queue (or the
 *      legacy inline lane). Attachments are only STAGED into the OpenClaw
 *      media store; the channel never transcribes/interprets media — that is
 *      the TATA agent runtime's job (tools.media audio understanding).
 *
 * The agent itself (Tata) owns reading Help Center articles and posting
 * replies back to Chatwoot using the Chatwoot CLI/tools. The plugin never
 * sends messages to Chatwoot.
 */
import { join } from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult
} from "openclaw/plugin-sdk/media-understanding";
import {
  chatwootPlugin,
  bindAccountResolver,
  createClient,
  resolveAccount,
  resolveChatwootConfig
} from "./src/channel.js";
import {
  dispatchAdmitted,
  handleConversationEvent,
  prepareInboundAck,
  type Dispatch,
  type DispatchRequest,
  type WebhookHandlerDeps
} from "./src/handler.js";
import { ChatwootConversation } from "./src/client.js";
import { DurableState } from "./src/state.js";
import { Spool, spoolKey, type SpoolRecord } from "./src/spool.js";
import { SpoolQueue, type ReconcileSource } from "./src/queue-spool.js";
import { DEFAULT_WEBHOOK_HEADER, DEFAULT_WEBHOOK_PATH } from "./src/types.js";
import { ConversationLanes } from "./src/queue.js";

type Api = Parameters<NonNullable<Parameters<typeof defineChannelPluginEntry>[0]["registerFull"]>>[0];
type CapabilitiesApi = Parameters<
  NonNullable<Parameters<typeof defineChannelPluginEntry>[0]["registerCapabilities"]>
>[0];

const CHANNEL = "chatwoot";

/** Chatwoot attachment with a staged local path (media store) or a remote URL. */
interface StagedAttachment {
  attachment: Record<string, unknown>;
  localPath?: string;
  remoteUrl?: string;
  mime: string;
}

/**
 * Register `llm-gateway` (the deployment's OpenAI-compatible LLM provider) as
 * an audio-transcription media provider using the shared OpenAI-compatible
 * implementation. Model/base URL come from tools.media config + env.
 *
 * MUST be called from `registerCapabilities` (not `registerFull`): the media
 * capability loader loads plugins in "discovery" mode (`activate: false`),
 * where `registerFull` is skipped — registering there would make the provider
 * invisible to the media pipeline.
 */
function registerGatewayMediaProvider(api: CapabilitiesApi): void {
  const defaultModel = "grok-stt-1-0";
  api.registerMediaUnderstandingProvider({
    id: "llm-gateway",
    capabilities: ["audio"],
    defaultModels: { audio: defaultModel },
    autoPriority: { audio: 30 },
    resolveAuth: () => {
      const apiKey = process.env.LLM_GATEWAY_API_KEY ?? "";
      return apiKey
        ? { kind: "api-key", apiKey, source: "env:LLM_GATEWAY_API_KEY" }
        : { kind: "none", source: "env:LLM_GATEWAY_API_KEY (missing)" };
    },
    transcribeAudio: (req: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> =>
      transcribeOpenAiCompatibleAudio({
        ...req,
        provider: "llm-gateway",
        defaultBaseUrl: process.env.LLM_GATEWAY_BASE_URL ?? "https://api.llmgateway.io/v1",
        defaultModel
      })
  });
}

/** Best-effort file extension so the media store keeps a recognizable name. */
function extFromMime(mime: string): string {
  const subtype = (mime.split("/")[1] ?? "").split(";")[0].trim().toLowerCase();
  switch (subtype) {
    case "mpeg":
    case "mp3":
      return "mp3";
    case "wav":
    case "x-wav":
      return "wav";
    case "ogg":
    case "oga":
    case "opus":
      return "oga";
    case "mp4":
    case "m4a":
    case "x-m4a":
      return "m4a";
    case "webm":
      return "webm";
    case "aac":
      return "m4a";
    case "amr":
      return "amr";
    default:
      return "bin";
  }
}

/** Bearer auth for downloading Chatwoot-hosted media (private ActiveStorage). */
function chatwootMediaHeaders(): Record<string, string> {
  const token = process.env.CHATWOOT_API_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  return token ? { "api-access-token": token } : {};
}

/**
 * Download + persist each attachment into the OpenClaw media store via the
 * plugin SDK. A failed staging falls back to the raw remote URL (still works
 * for publicly reachable media) so a voice note is never dropped.
 */
async function stageAttachments(
  attachments: Array<Record<string, unknown>>,
  log: { warn?: (msg: string, ctx?: Record<string, unknown>) => void },
  conversationId: string
): Promise<StagedAttachment[]> {
  const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-runtime");
  const out: StagedAttachment[] = [];
  for (const att of attachments) {
    const mime = String(att.content_type ?? att.mime_type ?? "audio/ogg");
    const rawUrl = String(att.data_url ?? "");
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) continue;
    try {
      // Chatwoot serves voice notes from its public (ActiveStorage redirect)
      // host. Fetch the bytes directly (size-capped, redirects followed), then
      // persist into the OpenClaw media store so the AGENT's media pipeline
      // reads a LOCAL path — the channel never interprets the audio.
      const res = await fetchWithCap(rawUrl, 25 * 1024 * 1024, chatwootMediaHeaders());
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? mime;
      const saved = await saveMediaBuffer(
        buffer,
        contentType,
        "chatwoot",
        25 * 1024 * 1024,
        `chatwoot-${String(att.id ?? Date.now())}.${extFromMime(contentType)}`
      );
      out.push({ attachment: att, localPath: saved.path, remoteUrl: rawUrl, mime: contentType });
    } catch (error) {
      log.warn?.("chatwoot: audio staging failed; passing raw URL through", {
        conversationId,
        error: (error as Error)?.message ?? String(error)
      });
      out.push({ attachment: att, remoteUrl: rawUrl, mime });
    }
  }
  return out;
}

/** fetch with a hard response-size cap and header propagation. */
async function fetchWithCap(
  url: string,
  maxBytes: number,
  headers: Record<string, string>
): Promise<Response> {
  const res = await fetch(url, { redirect: "follow", headers });
  if (!res.ok) throw new Error(`fetch ${url.slice(0, 60)} -> HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  return new Response(buf, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "" }
  });
}

export default defineChannelPluginEntry({
  id: "chatwoot",
  name: "Chatwoot",
  description: "Native OpenClaw channel plugin for Chatwoot (inbound adapter)",
  plugin: chatwootPlugin,
  /**
   * Capabilities are registered in EVERY registration mode (discovery
   * included) so the media-understanding loader can find the provider.
   */
  registerCapabilities(api: CapabilitiesApi) {
    // Media understanding: register the LLM Gateway as an audio (STT)
    // capability provider so OpenClaw's own media pipeline can transcribe
    // voice notes DURING THE TATA AGENT TURN. The channel plugin stages the
    // bytes (media transport) and never interprets them.
    registerGatewayMediaProvider(api);
  },
  registerFull(api: Api) {
    const config = resolveChatwootConfig(api.config);
    const pluginConfig = (api.pluginConfig ?? {}) as {
      stateDir?: string;
      timeoutMs?: number;
      settleMs?: number;
      dispatchRetries?: number;
      /** Set false to fall back to the legacy inline lane dispatch. */
      queueEnabled?: boolean;
      /** Reconcile interval (ms). Default 60000; 0 disables. */
      reconcileIntervalMs?: number;
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
      const statusNote = request.status ?? "unknown";
      const audio: Array<Record<string, unknown>> = (request.audioAttachments ?? []) as unknown as Array<Record<string, unknown>>;

      // Voice notes/images: Chatwoot stores attachments in private
      // ActiveStorage behind redirect URLs that need the Chatwoot API token.
      // The channel does NOT interpret them: it only stages the bytes into
      // the OpenClaw media store so the TATA agent (media understanding) can
      // transcribe/understand them. Staging failure still passes the raw URL.
      const mediaFacts: Array<{ path?: string; url?: string; contentType?: string }> = [];
      if (audio.length > 0) {
        const staged = await stageAttachments(audio, api.logger, request.conversationId);
        for (const item of staged) {
          mediaFacts.push({
            path: item.localPath,
            url: item.localPath ? undefined : item.remoteUrl,
            contentType: item.mime
          });
        }
      }

      const voiceNote = mediaFacts.length > 0 && !request.text;
      const customerLine = voiceNote ? "(mensagem de voz recebida)" : request.text;
      const promptText = `[Chatwoot Conversation ${request.conversationId} | Account ${request.accountId} | Status: ${statusNote}]
Customer: ${customerLine}`;

      const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
        Body: promptText,
        BodyForAgent: promptText,
        RawBody: request.text,
        CommandBody: request.text,
        MediaPaths: mediaFacts.map((m) => m.path).filter((u): u is string => Boolean(u)),
        MediaUrls: mediaFacts.map((m) => m.url).filter((u): u is string => Boolean(u)),
        MediaTypes: mediaFacts.map((m) => m.contentType ?? "application/octet-stream"),
        media: mediaFacts,
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
          sessionKey: request.sessionKey,
          status: request.status,
          audioAttachments: audio.map((a) => String(a.data_url ?? "")).filter(Boolean)
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

    // Session-runtime experiment: with the durable queue DISABLED, do not
    // pre-serialize turns either — submit each accepted webhook directly to
    // the same OpenClaw SessionKey and let the session queue own ordering.
    const queueEnabled = pluginConfig.queueEnabled !== false;

    const lanes = queueEnabled
      ? new ConversationLanes({
          dispatch,
          settleMs: pluginConfig.settleMs,
          dispatchRetries: pluginConfig.dispatchRetries,
          log: api.logger
        })
      : undefined;

    // Durable queue (OpenResponses submission model): webhook persists the
    // accepted event, answers 200, and a background worker drains the spool.
    const spoolDir = join(stateDir, "spool");
    const spool = new Spool({ rootDir: spoolDir });
    const client = createClient(config, pluginConfig.timeoutMs ?? 15000);

    const recordFor = (request: DispatchRequest): SpoolRecord => {
      const received = new Date();
      const settleMs = pluginConfig.settleMs ?? 800;
      return {
        key: spoolKey(request.accountId, request.messageId ?? `${request.sessionKey}:${received.getTime()}`),
        accountId: request.accountId,
        conversationId: request.conversationId,
        inboxId: request.raw.inbox?.id !== undefined ? String(request.raw.inbox.id) : undefined,
        messageId: request.messageId,
        text: request.text,
        senderId: request.senderId,
        statusAtReceipt: request.status ?? request.raw.conversation?.status,
        audioAttachments: request.audioAttachments
          ? (request.audioAttachments as unknown as Array<Record<string, unknown>>)
          : undefined,
        receivedAt: received.toISOString(),
        availableAt: new Date(received.getTime() + settleMs).toISOString(),
        attempt: 0,
        source: "webhook",
        payload: request.raw as Record<string, unknown>
      };
    };

    const requestFromRecord = (record: SpoolRecord): DispatchRequest => ({
      accountId: record.accountId,
      conversationId: record.conversationId,
      sessionKey: `chatwoot:${record.accountId}:${record.conversationId}`,
      text: record.text,
      messageId: record.messageId,
      senderId: record.senderId,
      status: record.statusAtReceipt,
      audioAttachments: record.audioAttachments
        ? (record.audioAttachments as unknown as DispatchRequest["audioAttachments"])
        : undefined,
      raw: record.payload as DispatchRequest["raw"]
    });

    const reconcileSource: ReconcileSource = {
      listConversations: async () =>
        (await client.listConversationsByStatus("pending")) as ChatwootConversation[],
      listConversationMessages: (conversationId: number) => client.listMessages(conversationId),
      getConversation: (conversationId: number) => client.getConversation(conversationId)
    };

    const queue = new SpoolQueue({
      spool,
      config,
      dispatch,
      toRequest: requestFromRecord,
      client: reconcileSource,
      log: api.logger,
      settleMs: pluginConfig.settleMs,
      reconcileIntervalMs: pluginConfig.reconcileIntervalMs,
      privateNote: async (record, reason) => {
        await client.sendPrivateNote(
          record.conversationId,
          `OpenClaw queue: message ${record.messageId} exhausted dispatch retries (${reason}).`
        );
      }
    });
    if (queueEnabled) void queue.start();

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

        // 1. Prepare and validate the ack. With the durable queue enabled, a
        //    dispatchable message is persisted BEFORE the response and the
        //    agent turn runs in the background worker — Chatwoot never sees
        //    agent failures, and nothing is lost on gateway restart.
        const ack = await prepareInboundAck(
          rawBody,
          eventDeps,
          queueEnabled ? { spool, recordFor } : {}
        );

        // 2. Respond immediately to Chatwoot (<10ms) so Chatwoot never times out!
        res.statusCode = ack.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: ack.status === 200, action: ack.action, reason: ack.reason }));

        // 3. Durable queue path: worker drains asynchronously; only wake it.
        if (ack.action === "accepted") {
          queue.wake();
          return;
        }

        // Legacy inline path (kept for backward compatibility when the spool
        // is disabled): run the agent turn inside this handler so the Gateway
        // root task stays admitted for the whole run.
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