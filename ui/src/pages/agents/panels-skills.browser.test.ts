import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { SkillStatusEntry } from "../../api/types.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { AgentSkills } from "./panels-skills.tsx";

installBrowserHistoryIsolation();

type Params = Parameters<typeof AgentSkills>[0] &
  Pick<
    ReturnType<Parameters<typeof AgentSkills>[0]["readData"]>,
    "agentSkillsReport" | "agentSkillsLoading" | "agentSkillsError" | "agentSkillsAgentId"
  >;
function skillsParams(skills: SkillStatusEntry[], overrides: Partial<Params> = {}): Params {
  return {
    readData() {
      return { ...createAgentViewTestProps().readData(), ...this };
    },
    agentId: "main",
    canPatchConfig: true,
    canUpdateConfig: true,
    agentSkillsReport: { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills },
    agentSkillsLoading: false,
    agentSkillsError: null,
    agentSkillsAgentId: "main",
    configForm: { agents: { entries: { main: {} } } },
    configLoading: false,
    configSaving: false,
    configDirty: false,
    filter: "",
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => false,
    onClear: () => undefined,
    onDisableAll: () => false,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

describe("agents skills panel (browser)", () => {
  it("shows inherited skills while resetting and restores the allowlist after rejection before retry", async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    const onClear = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const container = document.createElement("div");
    const params = skillsParams(
      [
        createSkill({ name: "github", source: "openclaw-managed" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "learned", source: "openclaw-workshop" }),
      ],
      {
        onClear,
        configForm: {
          agents: { defaults: { skills: ["github"] }, entries: { main: { skills: ["weather"] } } },
        },
      },
    );
    const view = mountSolid(AgentSkills, params, container);
    const reset = () =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Reset")!;
    const checked = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>(".agent-skill-row input")).map(
        (input) => input.checked,
      );
    await waitForSolid(() => expect(checked()).toEqual([true, false, true]));
    const filter = container.querySelector("input[name=agent-skills-filter]");

    reset().click();
    await waitForSolid(() => {
      expect(checked()).toEqual([true, true, false]);
      expect(container.textContent).toContain("Saving");
      expect(container.textContent).toContain("inherits the default skill allowlist");
    });
    first.reject(new Error("Reset was rejected."));
    await waitForSolid(() => {
      expect(container.textContent).toContain("Reset was rejected.");
      expect(checked()).toEqual([true, false, true]);
    });
    expect(container.querySelector("input[name=agent-skills-filter]")).toBe(filter);

    reset().click();
    await waitForSolid(() => {
      expect(container.textContent).toContain("Saving");
      expect(container.textContent).not.toContain("Reset was rejected.");
    });
    view.update({
      ...params,
      configForm: { agents: { defaults: { skills: ["github"] }, entries: { main: {} } } },
    });
    retry.resolve();
    await waitForSolid(() => {
      expect(checked()).toEqual([true, true, false]);
      expect(container.textContent).not.toContain("Saving");
      expect(container.textContent).not.toContain("Reset was rejected.");
    });
    expect(onClear).toHaveBeenNthCalledWith(1, "main");
    expect(onClear).toHaveBeenNthCalledWith(2, "main");
    expect(container.querySelector("input[name=agent-skills-filter]")).toBe(filter);
  });

  it("shows matches from default-collapsed groups while filtering", async () => {
    const container = document.createElement("div");
    const params = skillsParams([
      createSkill({ name: "Unique Built In Match", source: "openclaw-bundled", bundled: true }),
      createSkill({ name: "Installed Distractor", source: "openclaw-managed" }),
    ]);
    const view = mountSolid(AgentSkills, params, container);
    await Promise.resolve();
    expect(container.querySelector<HTMLDetailsElement>(".agent-skills-group")?.open).toBe(false);

    view.update({ ...params, filter: "Unique Built In Match" });
    await Promise.resolve();
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(container.textContent).toContain("1 shown");
    expect(filteredGroup?.open).toBe(true);
    expect(filteredGroup?.querySelector(".agent-skill-row")?.textContent).toContain(
      "Unique Built In Match",
    );
  });

  it("retires optimistic reset presentation when the selected agent changes", async () => {
    const completion = deferred<void>();
    const container = document.createElement("div");
    const params = skillsParams([createSkill({ name: "github", source: "openclaw-managed" })], {
      configForm: { agents: { entries: { main: { skills: [] }, research: { skills: [] } } } },
      onClear: () => completion.promise,
    });
    const view = mountSolid(AgentSkills, params, container);
    const checked = () =>
      container.querySelector<HTMLInputElement>(".agent-skill-row input")?.checked;
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Reset")!
      .click();
    await waitForSolid(() => expect(checked()).toBe(true));

    view.update({ ...params, agentId: "research", agentSkillsAgentId: "research" });
    await waitForSolid(() => {
      expect(checked()).toBe(false);
      expect(container.textContent).not.toContain("Saving");
    });
    completion.reject(new Error("Retired reset failed."));
    await completion.promise.catch(() => undefined);
    await waitForSolid(() => {
      expect(checked()).toBe(false);
      expect(container.textContent).not.toContain("Retired reset failed.");
    });
  });

  it("keeps learned Workshop skills on under an allowlist", async () => {
    const container = document.createElement("div");
    mountSolid(
      AgentSkills,
      skillsParams(
        [
          createSkill({ name: "github", source: "openclaw-managed" }),
          createSkill({ name: "budget", source: "openclaw-workshop" }),
        ],
        { configForm: { agents: { entries: { main: { skills: ["github"] } } } } },
      ),
      container,
    );
    await Promise.resolve();

    const learnedRow = Array.from(container.querySelectorAll(".agent-skill-row")).find((row) =>
      row.textContent?.includes("budget"),
    );
    const toggle = learnedRow?.querySelector<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
    expect(learnedRow?.textContent).toContain("archive in Workshop to hide");
    expect(container.textContent).toContain("2/2");
  });

  it.each(["inherited", "explicit without patch access"])(
    "gates clearing a %s allowlist separately from staged edits",
    async (mode) => {
      const inherited = mode === "inherited";
      const container = document.createElement("div");
      const skills = inherited
        ? [
            createSkill({ name: "github", source: "openclaw-managed" }),
            createSkill({
              name: "weather",
              source: "openclaw-managed",
              blockedByAgentFilter: true,
              modelVisible: false,
              commandVisible: false,
            }),
          ]
        : [];
      mountSolid(
        AgentSkills,
        skillsParams(skills, {
          canPatchConfig: inherited,
          configForm: {
            agents: inherited
              ? { defaults: { skills: ["github"] }, entries: { main: {} } }
              : { entries: { main: { skills: ["coding-agent"] } } },
          },
        }),
        container,
      );
      await Promise.resolve();
      if (inherited) {
        expect(container.querySelector(".callout.info")?.textContent).toContain(
          "inherits the default skill allowlist",
        );
        expect(
          Array.from(
            container.querySelectorAll<HTMLInputElement>(
              ".agent-skill-row input.settings-toggle__input",
            ),
          ).map((toggle) => toggle.checked),
        ).toEqual([true, false]);
      }
      const buttons = container.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons[0]?.disabled).toBe(false);
      expect(buttons[1]?.disabled).toBe(true);
    },
  );

  it("explains an unsatisfied one-of binary requirement", async () => {
    const container = document.createElement("div");
    const requirements = {
      bins: [],
      anyBins: ["claude", "codex", "opencode"],
      env: [],
      config: [],
      os: [],
    };
    const skill = createSkill({
      name: "Coding Agent",
      source: "openclaw-bundled",
      bundled: true,
      eligible: false,
      modelVisible: false,
      commandVisible: false,
      requirements,
      missing: requirements,
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    });
    mountSolid(AgentSkills, skillsParams([skill]), container);
    await Promise.resolve();
    expect(container.querySelector(".agent-skill-row")?.textContent).toContain(
      "bin:any of (claude, codex, opencode)",
    );
  });
});
