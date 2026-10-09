/**
 * OpenClaw plugin entry point.
 *
 * Registers the Chatwoot channel and the webhook HTTP route that receives
 * Chatwoot events, then drives the shared inbound lifecycle.
 */
import { join } from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { chatwootPlugin, bindAccountResolver, createClient, resolveAccount, resolveChatwootConfig } from "./src/channel.js";
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

export default defineChannelPluginEntry({
  id: "chatwoot",
  name: "Chatwoot",
  description: "Native OpenClaw channel plugin for Chatwoot",
  plugin: chatwootPlugin,
  registerFull(api: Api) {
    const config = resolveChatwootConfig(api.config);
    const pluginConfig = (api.pluginConfig ?? {}) as { stateDir?: string; timeoutMs?: number };
    const stateDir = pluginConfig.stateDir ?? process.env.OPENCLAW_CHATWOOT_STATE_DIR ?? api.resolvePath(".state");
    const state = DurableState.open({ filePath: join(stateDir, "chatwoot-state.json") });
    const client = createClient(config, pluginConfig.timeoutMs);

    // Let the outbound adapter resolve the live client without re-parsing config.
    bindAccountResolver((accountId) => resolveAccount(api.config, accountId));

    // Finish any handoff side effects interrupted by a restart.
    void recoverPendingEffects({ state, client, config, log: api.logger }).catch((error) =>
      api.logger.error?.(`chatwoot: recovery failed: ${(error as Error).message}`)
    );

    const dispatch: Dispatch = async (request) => {
      const inbound = api.runtime?.channel?.inbound;
      if (!inbound?.run) {
        throw new Error("chatwoot: runtime.channel.inbound.run is unavailable");
      }
      await inbound.run({
        channel: "chatwoot",
        accountId: request.accountId,
        raw: request.raw
      });
      // The shared inbound lifecycle delivers replies through this channel's
      // outbound adapter, so the reply is already handled.
      return { ok: true, delivered: true };
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
    const headerName = (config.webhookHeader ?? DEFAULT_WEBHOOK_HEADER).toLowerCase();

    api.registerHttpRoute({
      path: webhookPath,
      auth: "plugin",
      handler: async (req, res) => {
        const rawBody = await readRequestBody(req);
        const headerValue = req.headers?.[headerName];
        const signatureHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

        const event = safeParseEvent(rawBody);
        const isConversationEvent =
          typeof event === "string" &&
          (event === "conversation_updated" ||
            event === "conversation_status_changed" ||
            event === "conversation_created");

        const result = isConversationEvent
          ? await handleConversationEvent(rawBody, { ...deps, signatureHeader })
          : await handleWebhookEvent(rawBody, { ...deps, signatureHeader });

        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: result.status < 300, action: result.action, reason: result.reason }));
        return true;
      }
    });
  }
});

function safeParseEvent(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as { event?: unknown };
    return typeof parsed?.event === "string" ? parsed.event : undefined;
  } catch {
    return undefined;
  }
}

async function readRequestBody(req: {
  on(event: string, listener: (chunk?: unknown) => void): unknown;
}): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve, reject) => {
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk as Buffer)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(error as Error));
  });
}
