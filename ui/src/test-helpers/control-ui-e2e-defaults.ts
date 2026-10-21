import type {
  ChannelsStatusResult,
  EnvironmentsListResult,
  UserProfile,
  ProjectsCheckoutOptionsResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { SystemAgentChatHistoryResult } from "../../../packages/gateway-protocol/src/schema/openclaw.ts";
import type {
  PluginsCatalogBrowseResult,
  PluginsCatalogCategoriesResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.ts";
import { BUILTIN_THEMES } from "../../../packages/gateway-protocol/src/theme.js";
import type { DoctorMemoryStatusPayload } from "../../../src/gateway/server-methods/doctor.ts";
import type { ChannelsPairingListResult } from "../api/types.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-e2e-contract.ts";

function methods<const Prefix extends string, const Name extends string>(
  prefix: Prefix,
  names: readonly Name[],
) {
  return names.map((name) => `${prefix}.${name}` as const);
}

export const defaultControlUiFeatureMethods = [
  "agents.create",
  ...methods("chat", ["abort", "history", "send", "metadata", "startup"]),
  ...methods("config", ["apply", "patch", "schema", "set"]),
  ...methods("device.scopes", ["requestUpgrade", "waitUpgrade"]),
  ...methods("session.members", ["add", "list", "listEvidence", "remove"]),
  ...methods("session.reactions", ["list", "set"]),
  "session.visibility.set",
  ...methods("sessions", [
    "abort",
    "patchMany",
    "branches.switch",
    "compact",
    "create",
    "delete",
    "dispatch",
    "fork",
  ]),
  ...methods("sessions.groups", ["delete", "defaults", "list", "put", "rename", "update"]),
  ...methods("sessions", ["patch", "reclaim", "reset", "rewind", "search"]),
  "system.info",
  ...methods("users.github", [
    "status",
    "authorize.start",
    "authorize.poll",
    "authorize.cancel",
    "disconnect",
  ]),
  ...methods("sessions.github", ["options", "status", "confirm"]),
  ...methods("themes", ["list", "get", "set", "import"]),
  ...methods("tools.github", [
    "status",
    "configure",
    "authorize.start",
    "authorize.poll",
    "authorize.cancel",
  ]),
  ...methods("update", ["hold", "run", "runs.get", "runs.list", "status"]),
  "worktrees.branches",
] as const;

export function createControlUiDefaultResponses(scenario: {
  presenceUsers?: ControlUiMockPresenceUser[];
}) {
  const user = scenario.presenceUsers?.find((entry) => entry.self);
  const profile: UserProfile | null = user
    ? {
        id: user.id,
        displayName: user.name ?? null,
        emails: user.email ? [user.email] : [],
        avatarMime: null,
        hasAvatar: Boolean(user.avatarUrl),
        githubIdentity: null,
        mergedInto: null,
        createdAt: 1,
        updatedAt: 1,
      }
    : null;
  const selection = {
    theme: BUILTIN_THEMES[0],
    current: { id: "claw", mode: "system", scope: "gateway", overrides: {} },
  };
  return {
    "openclaw.chat.history": { turns: [] } satisfies SystemAgentChatHistoryResult,
    "environments.list": {
      environments: [],
      profiles: [],
    } satisfies EnvironmentsListResult,
    "projects.checkoutOptions": {
      current: true,
      worktree: true,
    } satisfies ProjectsCheckoutOptionsResult,
    "doctor.memory.status": {
      agentId: "main",
      provider: "none",
      embedding: { ok: false, checked: false },
    } satisfies DoctorMemoryStatusPayload,
    "channels.status": {
      ts: 0,
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    } satisfies ChannelsStatusResult,
    "channels.pairing.list": {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    } satisfies ChannelsPairingListResult,
    "plugins.catalog.categories": { categories: [] } satisfies PluginsCatalogCategoriesResult,
    "plugins.catalog.browse": { items: [] } satisfies PluginsCatalogBrowseResult,
    "users.self": profile
      ? { profile }
      : {
          __mockError: { code: "FORBIDDEN", message: "users.self requires an authenticated user" },
        },
    "themes.list": { ...selection, themes: BUILTIN_THEMES },
    "themes.get": selection,
  };
}
