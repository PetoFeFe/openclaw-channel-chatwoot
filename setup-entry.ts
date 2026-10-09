import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { chatwootPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(chatwootPlugin);
