/**
 * OpenClaw native Chatwoot channel plugin (inbound only).
 *
 *   1. Verifies the HMAC signature on incoming webhooks (401 on bad signature).
 *   2. Deduplicates deliveries and Chatwoot message ids via durable state.
 *   3. Filters account scope and incoming/private/self messages.
 *   4. Acknowledges HTTP 200 immediately so Chatwoot webhooks never time out.
 *   5. Submits the inbound message to the routed OpenClaw agent session.
 *   6. Stages voice-note/image attachments into the OpenClaw media store; the
 *      agent runtime owns transcription and understanding.
 *
 * The plugin never sends Chatwoot messages, private notes, or assignments.
 * Tata owns every Chatwoot action through the official CLI/tools.
 */
import { join } from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult
} from "openclaw/plugin-sdk/media-understanding";
import { chatwootPlugin, resolveChatwootConfig } from "./src/channel.js";
import {
  prepareInboundAck,
  type Dispatch,
  type WebhookHandlerDeps
} from "./src/handler.js";
import { DurableState } from "./src/state.js";
import {
  DEFAULT_WEBHOOK_HEADER,
  DEFAULT_WEBHOOK_PATH,
  type ChatwootPluginConfig
} from "./src/types.js";

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

/** Bearer auth for downloading Chatwoot-hosted inbound media. */
function chatwootMediaHeaders(apiToken: string): Record<string, string> {
  const token = apiToken || process.env.CHATWOOT_API_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
  return token ? { "api-access-token": token } : {};
}

/** Resolve a Chatwoot attachment URL against the configured base URL. */
function attachmentUrl(rawUrl: string, baseUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Download + persist each attachment into the OpenClaw media store via the
 * plugin SDK. A failed staging falls back to the raw remote URL (still works
 * for publicly reachable media) so a voice note is never dropped.
 */
async function stageAttachments(
  attachments: Array<Record<string, unknown>>,
  log: { warn?: (msg: string, ctx?: Record<string, unknown>) => void },
  conversationId: string,
  baseUrl: string,
  apiToken: string
): Promise<StagedAttachment[]> {
  const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-runtime");
  const out: StagedAttachment[] = [];
  for (const att of attachments) {
    const mime = String(att.content_type ?? att.mime_type ?? "audio/ogg");
    const rawUrl = String(att.data_url ?? "");
    const mediaUrl = attachmentUrl(rawUrl, baseUrl);
    if (!mediaUrl) continue;
    try {
      // Chatwoot serves voice notes from private ActiveStorage redirect URLs.
      // Fetch the bytes directly (size-capped, redirects followed), then
      // persist into the OpenClaw media store so the AGENT's media pipeline
      // reads a LOCAL path — the channel never interprets the audio.
      const res = await fetchWithCap(mediaUrl, 25 * 1024 * 1024, chatwootMediaHeaders(apiToken));
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? mime;
      const saved = await saveMediaBuffer(
        buffer,
        contentType,
        "chatwoot",
        25 * 1024 * 1024,
        `chatwoot-${String(att.id ?? Date.now())}.${extFromMime(contentType)}`
      );
      out.push({ attachment: att, localPath: saved.path, remoteUrl: mediaUrl, mime: contentType });
    } catch (error) {
      log.warn?.("chatwoot: media staging failed; passing raw URL through", {
        conversationId,
        error: (error as Error)?.message ?? String(error)
      });
      out.push({ attachment: att, remoteUrl: mediaUrl, mime });
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
  description: "Native OpenClaw channel plugin for Chatwoot (inbound only)",
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
    const pluginConfig = (api.pluginConfig ?? {}) as ChatwootPluginConfig;
    const stateDir =
      pluginConfig.stateDir ?? process.env.OPENCLAW_CHATWOOT_STATE_DIR ?? api.resolvePath(".state");
    const state = DurableState.open({ filePath: join(stateDir, "chatwoot-state.json") });

    const dispatch: Dispatch = async (request) => {
      // Resolve the routed agent for this conversation.
      const agentRoute = api.runtime.channel.routing.resolveAgentRoute({
        cfg: api.config,
        channel: CHANNEL,
        accountId: request.accountId,
        peer: { kind: "direct", id: request.conversationId }
      });

      const coreSessionKey = request.sessionKey.startsWith("agent:")
        ? request.sessionKey
        : `agent:${agentRoute.agentId}:${request.sessionKey}`;

      const senderAddress = request.senderId ?? request.conversationId;
      const messageSid =
        request.messageId !== undefined
          ? String(request.messageId)
          : `${request.sessionKey}:${Date.now()}`;

      const statusNote = request.status ?? "unknown";
      const audio: Array<Record<string, unknown>> = (request.audioAttachments ??
        []) as unknown as Array<Record<string, unknown>>;

      // Voice notes/images: Chatwoot stores attachments in private
      // ActiveStorage behind redirect URLs that need the Chatwoot API token.
      // The channel does NOT interpret them: it only stages the bytes into
      // the OpenClaw media store so the TATA agent (media understanding) can
      // transcribe/understand them. Staging failure still passes the raw URL.
      const mediaFacts: Array<{ path?: string; url?: string; contentType?: string }> = [];
      if (audio.length > 0) {
        const staged = await stageAttachments(
          audio,
          api.logger,
          request.conversationId,
          config.baseUrl,
          config.apiToken
        );
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

      // Inbound delivery is session-owned: submit directly through the
      // OpenClaw Gateway. The session runtime serializes/coalesces turns
      // natively, so there is no plugin-side queue or lane.
      const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
      const sendParams = {
        key: coreSessionKey,
        message: promptText,
        idempotencyKey: messageSid
      };
      try {
        await callGatewayFromCli("sessions.send", {}, sendParams);
      } catch (err: any) {
        const errMsg = String(err?.message ?? err?.details?.message ?? err);
        if (errMsg.includes("session not found")) {
          await callGatewayFromCli("sessions.create", {}, { key: coreSessionKey });
          await callGatewayFromCli("sessions.send", {}, sendParams);
        } else {
          throw err;
        }
      }

      return { ok: true };
    };

    const deps: WebhookHandlerDeps = {
      config,
      state,
      dispatch,
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

        const eventDeps: WebhookHandlerDeps = {
          ...deps,
          signatureHeader,
          timestampHeader,
          deliveryId
        };

        // 1. Authenticate, classify, and claim the message id before any work.
        const ack = await prepareInboundAck(rawBody, eventDeps);

        // 2. Respond immediately to Chatwoot (<10ms) so Chatwoot never times out.
        res.statusCode = ack.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: ack.status === 200, action: ack.action, reason: ack.reason }));

        // 3. Run the turn inside this handler so the Gateway root task stays
        //    admitted for the whole run. On submission error: do NOT retry, do
        //    NOT hand off, and do NOT open the conversation. Log the failure
        //    and leave the Chatwoot conversation pending.
        if (ack.action === "dispatched" && ack.request) {
          try {
            await dispatch(ack.request);
          } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            api.logger.warn?.(
              `chatwoot: inbound session dispatch failed (conv ${ack.request.conversationId}, msg ${ack.request.messageId}): ${msg}`
            );
          }
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

async function readRequestBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
