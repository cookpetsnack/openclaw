import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
} from "solid-js";
import {
  SettingsSection,
  SettingsRow,
  SettingsToggle,
  SettingsEmpty,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { groupSkills } from "../../lib/skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  isWorkshopSkill,
} from "../../lib/skills-shared.ts";
import { SkillStatusChips } from "../skills/skill-status.tsx";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { AgentPanelAction } from "./panel-ui.tsx";

registerSettingsEnglish();

type AgentSkillsProps = AgentConfigActions &
  AgentsPageView["agentSkills"] &
  Pick<AgentsPageView, "readData"> & {
    agentId: string;
    configForm: Record<string, unknown> | null;
    canPatchConfig: boolean;
  };

export function AgentSkills(params: AgentSkillsProps) {
  const scope = createMemo(() => `${params.agentId}:${params.readData().requestGeneration}`);
  return (
    <Show when={scope()} keyed>
      {(_scope) => {
        const config = createMemo(() => resolveAgentConfig(params.configForm, params.agentId));
        const [explicit, setExplicit] = createOptimistic(() =>
          Array.isArray(config().entry?.skills),
        );
        const [resetting, setResetting] = createOptimistic(false);
        const [command, setCommand] = createSignal<Promise<void> | null>(null);
        const allowlist = createMemo(() => {
          const skills = explicit() ? config().entry?.skills : config().defaults?.skills;
          return Array.isArray(skills) ? normalizeStringEntries(skills) : undefined;
        });
        const reset = action(function* (completion: Promise<void>) {
          setExplicit(false);
          setResetting(true);
          yield completion;
        });
        const onClear = () => {
          const completion = params.onClear(params.agentId);
          if (!completion) {
            return;
          }
          const operation = reset(completion);
          void operation.catch(() => undefined);
          setCommand(() => operation);
        };
        const commandStatus = (
          <Show when={command()} keyed>
            {(completion) => {
              const settled = createMemo(async () => {
                await completion;
                return null;
              });
              return (
                <Errored
                  fallback={(error) => <div class="callout danger">{formatUiError(error())}</div>}
                >
                  <Loading fallback={null}>{settled()}</Loading>
                </Errored>
              );
            }}
          </Show>
        );
        return (
          <AgentSkillsContent
            {...params}
            explicit={explicit()}
            allowlist={allowlist()}
            resetting={resetting()}
            commandStatus={commandStatus}
            onClear={onClear}
          />
        );
      }}
    </Show>
  );
}

function AgentSkillsContent(
  params: Omit<AgentSkillsProps, "onClear"> & {
    onClear: () => void;
    explicit: boolean;
    allowlist: string[] | undefined;
    resetting: boolean;
    commandStatus: JSX.Element;
  },
) {
  const configReady = () =>
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !params.resetting;
  const editable = () => params.canUpdateConfig && configReady();
  const allowSet = createMemo(() => new Set(params.allowlist ?? []));
  const usingAllowlist = () => params.allowlist !== undefined;
  const reportReady = () =>
    Boolean(
      params.readData().agentSkillsReport &&
      params.readData().agentSkillsAgentId === params.agentId,
    );
  const rawSkills = createMemo(() =>
    reportReady() ? (params.readData().agentSkillsReport?.skills ?? []) : [],
  );
  const filter = createMemo(() => normalizeLowercaseStringOrEmpty(params.filter));
  const filtered = createMemo(() =>
    filter()
      ? rawSkills().filter((skill) =>
          normalizeLowercaseStringOrEmpty(
            [skill.name, skill.description, skill.source].join(" "),
          ).includes(filter()),
        )
      : rawSkills(),
  );
  const groups = createMemo(() => groupSkills(filtered()));
  const enabledCount = createMemo(() =>
    usingAllowlist()
      ? rawSkills().filter((skill) => isWorkshopSkill(skill) || allowSet().has(skill.name)).length
      : rawSkills().length,
  );

  return (
    <>
      {!params.configForm ? (
        <div class="callout info">{t("agents.skillsPanel.loadConfig")}</div>
      ) : undefined}
      <div class="callout info">
        {t(
          usingAllowlist()
            ? !params.explicit
              ? "agents.skillsPanel.inheritedAllowlist"
              : "agents.skillsPanel.customAllowlist"
            : "agents.skillsPanel.allEnabled",
        )}
      </div>
      {!reportReady() && !params.readData().agentSkillsLoading ? (
        <div class="callout info">{t("agents.skillsPanel.loadAgent")}</div>
      ) : undefined}
      {params.readData().agentSkillsError ? (
        <div class="callout danger">{params.readData().agentSkillsError}</div>
      ) : (
        params.commandStatus
      )}
      <SettingsSection
        title={t("agents.skillsPanel.title")}
        description={
          <>
            {t("agents.skillsPanel.subtitle")}
            {rawSkills().length > 0 ? (
              <span class="mono">
                {enabledCount()}/{rawSkills().length}
              </span>
            ) : undefined}
          </>
        }
        actions={
          <>
            <AgentPanelAction
              label={t("agentTools.disableAll")}
              disabled={!editable()}
              onClick={() => params.onDisableAll(params.agentId)}
            />
            <AgentPanelAction
              label={t(params.resetting ? "common.saving" : "common.reset")}
              disabled={!params.canPatchConfig || !params.explicit || !configReady()}
              onClick={() => params.onClear()}
            />
            <AgentConfigButtons {...params}>
              <AgentPanelAction
                label={
                  params.readData().agentSkillsLoading ? t("common.loading") : t("common.refresh")
                }
                disabled={params.readData().agentSkillsLoading}
                onClick={params.onRefresh}
              />
            </AgentConfigButtons>
          </>
        }
      >
        <SettingsRow
          title={t("agents.skillsPanel.filter")}
          description={t("agents.skillsPanel.shown", { count: String(filtered().length) })}
          control={
            <input
              class="settings-input"
              aria-label={t("agents.skillsPanel.filter")}
              value={params.filter}
              onInput={(event) => params.onFilterChange(event.currentTarget.value)}
              placeholder={t("agents.skillsPanel.searchPlaceholder")}
              autocomplete="off"
              name="agent-skills-filter"
            />
          }
        />
        {filtered().length === 0 ? (
          <SettingsEmpty message={t("agents.skillsPanel.empty")} />
        ) : (
          <div class="agents-panel-body agent-skills-groups">
            <For each={groups()} keyed={(group) => group.id}>
              {(group) => (
                <details
                  class="agent-skills-group"
                  open={
                    Boolean(filter()) || (group().id !== "workspace" && group().id !== "built-in")
                  }
                >
                  <summary class="agent-skills-header">
                    <span>{group().label}</span>
                    <span class="muted">{group().skills.length}</span>
                  </summary>
                  <div class="list skills-grid">
                    <For each={group().skills} keyed={(skill) => skill.name}>
                      {(skill) => {
                        const learned = () => isWorkshopSkill(skill());
                        const enabled = () =>
                          learned() || !usingAllowlist() || allowSet().has(skill().name);
                        return (
                          <div class="settings-row agent-skill-row">
                            <div class="settings-row__text">
                              <span class="settings-row__title">
                                {skill().emoji ? `${skill().emoji} ` : ""}
                                {skill().name}
                              </span>
                              <span class="settings-row__desc">{skill().description}</span>
                              <SkillStatusChips skill={skill()} />
                              <For
                                each={
                                  [
                                    ["agents.skillsPanel.missing", computeSkillMissing(skill())],
                                    ["agents.skillsPanel.reason", computeSkillReasons(skill())],
                                  ] as const
                                }
                              >
                                {(entry) =>
                                  entry[1].length > 0 ? (
                                    <span class="settings-row__desc">
                                      {t(entry[0], { items: entry[1].join(", ") })}
                                    </span>
                                  ) : undefined
                                }
                              </For>
                              {learned() ? (
                                <span class="settings-row__desc">
                                  {t("agents.skillsPanel.learnedAlwaysOn")}
                                </span>
                              ) : undefined}
                            </div>
                            <div class="settings-row__control">
                              <SettingsToggle
                                checked={enabled()}
                                disabled={learned() || !editable()}
                                ariaLabel={skill().name}
                                onChange={(checked) =>
                                  params.onToggle(params.agentId, skill().name, checked)
                                }
                              />
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </details>
              )}
            </For>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
