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

function resolveOutboundAccount(
  params: { account?: unknown; accountId?: unknown; to?: unknown }
): ResolvedChatwootAccount | undefined {
  if (params.account && typeof params.account === "object") {
    return params.account as ResolvedChatwootAccount;
  }
  const accountId = typeof params.accountId === "string" ? params.accountId : undefined;
  if (accountResolver) return accountResolver(accountId);
  if (params.to) {
    const parsed = parseTarget(String(params.to));
    if (parsed.accountId) return accountResolver ? accountResolver(parsed.accountId) : undefined;
  }
  return undefined;
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
  }),

  security: {
    dm: {
      channelKey: "chatwoot",
      resolvePolicy: (account) => account.config.dmSecurity,
      resolveAllowFrom: (account) => account.config.allowFrom ?? [],
      defaultPolicy: "allowlist"
    }
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "chatwoot",
      sendText: async (params) => {
        // `params.to` is the resolved conversation target; when the account is
        // not resolvable from the target we fall back to the bound resolver.
        const target = String(params.to ?? "");
        const parsed = parseTarget(target);
        const account = resolveOutboundAccount(params);
        if (!account) throw new Error("chatwoot: outbound requires a resolved account");
        const result = await account.client.sendMessage({
          conversationId: parsed.conversationId,
          content: params.text
        });
        return { messageId: result.messageId };
      }
    },
    base: {
      sendMedia: async (params) => {
        const account = resolveOutboundAccount(params);
        if (!account) throw new Error("chatwoot: outbound requires a resolved account");
        const parsed = parseTarget(String(params.to ?? ""));
        // Chatwoot public API supports attachments via multipart; for now we send
        // a text notice referencing the media path and leave upload wiring to the
        // operator-configured Chatwoot inbox.
        await account.client.sendMessage({
          conversationId: parsed.conversationId,
          content: params.text ?? params.filePath ?? ""
        });
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
