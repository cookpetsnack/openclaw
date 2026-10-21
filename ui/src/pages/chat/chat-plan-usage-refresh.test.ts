/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { refreshChatModelAuthStatus } from "./chat-state-refresh.ts";

it("updates the open popover after two quick runs and one SWR recheck each", async () => {
  const startedAt = Date.now();
  let now = startedAt;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => {
    vi.useRealTimers();
    clock.mockRestore();
  });
  const key = "agent:main:plan-usage";
  let usedPercent = 1;
  const auth = vi.fn((_method: string, _params: unknown): ModelAuthStatusResult => ({
    ts: now,
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          {
            profileId: "openai:test",
            type: "oauth",
            status: "ok",
            expiry: { at: startedAt + 7 * 86_400_000, remainingMs: 7 * 86_400_000, label: "7d" },
          },
        ],
        usage: { providerId: "openai", plan: "Plus", windows: [{ label: "5h", usedPercent }] },
      },
    ],
  }));
  const fixture = createMountedPanes(
    [
      {
        key,
        agentId: "main",
        kind: "direct",
        sessionId: "plan-usage",
        updatedAt: 1,
        modelProvider: "openai",
        model: "test-model",
      },
    ],
    "main",
    undefined,
    { "models.authStatus": auth },
  );
  await fixture.sessions.refresh({ agentId: "main", force: true });
  const panes = [fixture.mount(key), fixture.mount(key)];
  for (const pane of panes) {
    document.body.append(pane.element);
    onTestFinished(() => pane.element.remove());
  }
  const [pane] = panes;
  await Promise.all(
    panes.map(async (currentPane) => {
      await refreshPane(currentPane);
      await refreshChatModelAuthStatus(currentPane.state);
    }),
  );
  await waitForSolid(() =>
    expect(pane.element.querySelector(".context-usage summary")).not.toBeNull(),
  );
  pane.element.querySelector<HTMLElement>(".context-usage summary")!.click();
  await waitForSolid(() =>
    expect(
      pane.element.querySelector(".context-usage__limit")?.textContent,
      "initial usage",
    ).toContain("1%"),
  );
  expect(auth).toHaveBeenCalledTimes(1);
  // Keep rendering setup on real timers; only the bounded rechecks use fake time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const [index, nextUsage] of [18, 22].entries()) {
    now = startedAt + (index + 1) * 10_000;
    fixture.emitGatewayEvent("chat", {
      sessionKey: key,
      agentId: "main",
      runId: `usage-run-${index}`,
      seq: 1,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: now },
    });
    await waitForSolid(() => expect(auth).toHaveBeenCalledTimes(2 + index * 2));
    // The forced read returns the previous snapshot. The background provider
    // fetch then publishes new usage before the one delayed ordinary read.
    usedPercent = nextUsage;
    await vi.advanceTimersByTimeAsync(5_500);
    await waitForSolid(() =>
      expect(
        pane.element.querySelector(".context-usage__limit")?.textContent,
        "refreshed usage",
      ).toContain(String(nextUsage) + "%"),
    );
    expect(auth).toHaveBeenCalledTimes(3 + index * 2);
    expect(pane.element.querySelector<HTMLDetailsElement>(".context-usage details")?.open).toBe(
      true,
    );
  }
  await vi.advanceTimersByTimeAsync(120_000);
  expect(auth).toHaveBeenCalledTimes(5);
  expect(auth.mock.calls.map(([, params]) => params)).toEqual([
    { agentId: "main" },
    { agentId: "main", refresh: true },
    { agentId: "main" },
    { agentId: "main", refresh: true },
    { agentId: "main" },
  ]);
});
