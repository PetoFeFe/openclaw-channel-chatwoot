/**
 * OpenClaw channel plugin object for Chatwoot.
 *
 * Built with the documented `openclaw/plugin-sdk/channel-core` surface:
 *   createChannelPluginBase + createChatChannelPlugin + createChatChannelPlugin
 *
 * The SDK is experimental and versioned with OpenClaw; imports are kept to the
 * documented channel-core subpath only.
 */
import {
  createChatChannelPlugin,
  createChannelPluginBase
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { ChatwootClient } from "./client.js";
import { normalizeChannelConfig, type ChatwootChannelConfig } from "./types.js";

export interface ResolvedChatwootAccount {
  accountId: string | null;
  config: ChatwootChannelConfig;
  client: ChatwootClient;
}

type UnknownRecord = Record<string, unknown>;

/** The exact `base` surface `createChatChannelPlugin` accepts. */
type ChatwootChatBase = Parameters<typeof createChatChannelPlugin<ResolvedChatwootAccount>>[0]["base"];

function channelSection(cfg: OpenClawConfig, accountId?: string | null): UnknownRecord {
  const channels = ((cfg as unknown as { channels?: UnknownRecord }).channels ?? {}) as UnknownRecord;
  const section = (channels["chatwoot"] ?? {}) as UnknownRecord;
  const accounts = section.accounts as UnknownRecord | undefined;
  if (accountId && accountId !== "default" && accounts && accounts[accountId]) {
    return { ...section, ...(accounts[accountId] as UnknownRecord) };
  }
  return section;
}

export function resolveChatwootConfig(
  cfg: OpenClawConfig,
  accountId?: string | null
): ChatwootChannelConfig {
  return normalizeChannelConfig(channelSection(cfg, accountId));
}

export function createClient(
  config: ChatwootChannelConfig,
  timeoutMs = 15000
): ChatwootClient {
  return new ChatwootClient({
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    apiToken: config.apiToken,
    timeoutMs,
    maxRetries: config.maxRetries
  });
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedChatwootAccount {
  const config = resolveChatwootConfig(cfg, accountId);
  return { accountId: accountId ?? null, config, client: createClient(config) };
}

/**
 * Outbound send functions receive delivery params, not necessarily the resolved
 * account object. registerFull binds a resolver here so outbound can always get
 * the live client without re-parsing config.
 */
let accountResolver: ((accountId?: string | null) => ResolvedChatwootAccount) | undefined;

export function bindAccountResolver(
  resolver: (accountId?: string | null) => ResolvedChatwootAccount
): void {
  accountResolver = resolver;
}

function resolveOutboundAccount(params: {
  cfg?: OpenClawConfig;
  accountId?: string | null;
  to?: string;
}): ResolvedChatwootAccount | undefined {
  if (params.cfg) return resolveAccount(params.cfg, params.accountId ?? undefined);
  const targetAccountId = params.to ? parseTarget(params.to).accountId : undefined;
  if (accountResolver) return accountResolver(params.accountId ?? targetAccountId);
  return undefined;
}

function messageIdOrEmpty(messageId: number | string | null | undefined): string {
  return messageId === undefined || messageId === null ? "" : String(messageId);
}

export const chatwootPlugin = createChatChannelPlugin<ResolvedChatwootAccount>({
  base: createChannelPluginBase({
    id: "chatwoot",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount(cfg, accountId) {
        const section = channelSection(cfg, accountId);
        const configured = Boolean(section.baseUrl && section.accountId && section.apiToken);
        return {
          enabled: configured,
          configured,
          tokenStatus: section.apiToken ? "available" : "missing"
        };
      }
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) =>
        ({
          ...(cfg as UnknownRecord),
          channels: {
            ...((cfg as unknown as { channels?: UnknownRecord }).channels ?? {}),
            chatwoot: {
              ...(channelSection(cfg)),
              ...(input as UnknownRecord)
            }
          }
        }) as OpenClawConfig
    }
    // The base helper returns `config?` while the chat plugin base requires it;
    // the object literal above is validated against the helper's option type.
  }) as unknown as ChatwootChatBase,

  security: {
    dm: {
      channelKey: "chatwoot",
      resolvePolicy: (account) => account.config.dmSecurity ?? "open",
      resolveAllowFrom: (account) => account.config.allowFrom ?? [],
      defaultPolicy: "open"
    }
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: "chatwoot",
      sendText: async (ctx) => {
        // `ctx.to` is the resolved conversation target; the account comes from
        // the config carried in the delivery context (or the bound resolver).
        const parsed = parseTarget(ctx.to);
        const account = resolveOutboundAccount(ctx);
        if (!account) throw new Error("chatwoot: outbound requires a resolved account");
        const result = await account.client.sendMessage({
          conversationId: parsed.conversationId,
          content: ctx.text
        });
        return { messageId: messageIdOrEmpty(result.messageId) };
      },
      sendMedia: async (ctx) => {
        const parsed = parseTarget(ctx.to);
        const account = resolveOutboundAccount(ctx);
        if (!account) throw new Error("chatwoot: outbound requires a resolved account");
        // Chatwoot's public API accepts attachments via multipart upload. Until
        // that adapter is wired we forward the caption/URL as text so nothing is
        // silently dropped.
        const result = await account.client.sendMessage({
          conversationId: parsed.conversationId,
          content: ctx.text || ctx.mediaUrl || ""
        });
        return { messageId: messageIdOrEmpty(result.messageId) };
      }
    }
  }
});

export function parseTarget(target: string): { accountId?: string; conversationId: string } {
  // Accept "chatwoot:<account_id>:<conversation_id>" or a bare conversation id.
  const match = /^chatwoot:([^:]+):(.+)$/.exec(target);
  if (match) return { accountId: match[1], conversationId: match[2] };
  return { conversationId: target };
}
