/**
 * OpenClaw channel plugin object for Chatwoot.
 *
 * This is an inbound-only channel: it declares no outbound adapter. The agent
 * (or its tools) owns every Chatwoot reply, note, and assignment.
 *
 * Built with the documented `openclaw/plugin-sdk/channel-core` surface:
 *   createChannelPluginBase + createChatChannelPlugin
 */
import {
  createChatChannelPlugin,
  createChannelPluginBase
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { normalizeChannelConfig, type ChatwootChannelConfig } from "./types.js";

export interface ResolvedChatwootAccount {
  accountId: string | null;
  config: ChatwootChannelConfig;
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

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedChatwootAccount {
  return { accountId: accountId ?? null, config: resolveChatwootConfig(cfg, accountId) };
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
  }
});
