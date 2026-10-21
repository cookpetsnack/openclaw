import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";

export type AgentSkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
};

export async function loadAgentSkills(state: AgentSkillsState, agentId: string) {
  const client = state.client;
  if (!client || !state.connected || state.agentSkillsLoading) {
    return;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentSkillsLoading = true;
  state.agentSkillsError = null;
  try {
    const res = await loadSkillStatusReport(client, agentId);
    if (res && isCurrent()) {
      state.agentSkillsReport = res;
      state.agentSkillsAgentId = agentId;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentSkillsError = formatUiError(err);
    }
  } finally {
    if (isCurrent()) {
      state.agentSkillsLoading = false;
    }
  }
}

export async function clearAgentSkillFilter(
  runtimeConfig: RuntimeConfigCapability,
  agentId: string,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  const target = runtimeConfig.agentEntry(agentId);
  if (!target || !Array.isArray(target.entry.skills) || !canDispatch()) {
    return false;
  }
  const targetKey = target.path[2];
  if (typeof targetKey !== "string") {
    return false;
  }
  return runtimeConfig.patch({
    raw: {
      agents: {
        entries: {
          [targetKey]: { skills: null },
        },
      },
    },
    note: "Reset agent skills to inherited defaults",
    replacePaths: [`agents.entries.${targetKey}.skills`],
    canDispatch,
  });
}

export function createAgentSkillsReset(options: {
  state: AgentSkillsState;
  context: Pick<ApplicationContext, "agents" | "runtimeConfig">;
  canReset: () => boolean;
  isCurrent: (
    client: GatewayBrowserClient,
    generation: number,
    agentId: string,
    agents: ApplicationContext["agents"],
  ) => boolean;
  onUpdated: (agentId: string) => void;
}) {
  let lifetime = Promise.withResolvers<void>();
  return {
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    clear(agentId: string) {
      if (!options.canReset()) {
        return;
      }
      const { state, context } = options;
      const client = state.client;
      const generation = state.requestGeneration;
      const agents = context.agents;
      const runtimeConfig = context.runtimeConfig;
      if (!client) {
        return;
      }
      const canDispatch = () =>
        context.runtimeConfig === runtimeConfig &&
        options.isCurrent(client, generation, agentId, agents) &&
        options.canReset();
      if (!canDispatch()) {
        return;
      }
      const retirement = lifetime.promise;
      const completion = clearAgentSkillFilter(runtimeConfig, agentId, canDispatch).then(
        (updated) => {
          if (!canDispatch()) {
            return;
          }
          if (!updated) {
            throw new Error(runtimeConfig.state.lastError ?? t("agents.skillsPanel.updateError"));
          }
          options.onUpdated(agentId);
        },
      );
      // Retire presentation synchronously; the config owner still records the write outcome.
      return Promise.race([completion, retirement]);
    },
  };
}
