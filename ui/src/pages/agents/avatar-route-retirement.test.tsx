/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  createAgentsPage,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { AvatarPicker, type GeneratedAvatar } from "./avatar-picker.tsx";

it("leaves the avatar route before its admitted generation settles", async () => {
  const pending = createDeferred<GeneratedAvatar>();
  const request = vi.fn((method: string) => {
    if (method !== "agents.avatar.generate") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return pending.promise;
  });
  const currentGateway = gateway({
    ...snapshot(createTestGatewayClient(request)),
    hello: gatewayHelloForMethods(["agents.update", "agents.avatar.generate"]),
  });
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  const context = pageContext(currentGateway, agents);
  const page = createAgentsPage(
    context,
    agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
  );
  const select = vi.fn();
  const mounted = mountSolid(() => {
    const [avatarPage, setAvatarPage] = createSignal(true);
    return (
      <>
        <button onClick={() => setAvatarPage(false)}>Leave avatar page</button>
        <Show when={avatarPage()} fallback={<p>Next route</p>}>
          <AvatarPicker
            agentId="main"
            avatar={null}
            disabled={false}
            onSelect={select}
            onUpload={() => undefined}
            onGenerate={(prompt) => page.read().overview.onIdentityAvatarGenerate(prompt)}
          />
        </Show>
      </>
    );
  });
  try {
    mounted.getByRole("button", { name: /^Generate$/ }).click();
    const prompt = await waitForSolid(() => mounted.getByRole<HTMLTextAreaElement>("textbox"));
    prompt.value = "A patient gardener";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(mounted.getAllByRole("button", { name: /^Generate$/ })).toHaveLength(2),
    );
    const generateButton = mounted.getAllByRole("button", { name: /^Generate$/ })[1];
    if (!generateButton) {
      throw new Error("Avatar generation button is missing");
    }
    generateButton.click();
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      "agents.avatar.generate",
      { agentId: "main", prompt: "A patient gardener" },
      { timeoutMs: 100_000 },
    );
    mounted.getByRole("button", { name: "Leave avatar page" }).click();
    await waitForSolid(() => expect(mounted.container.textContent).toContain("Next route"));
    expect(mounted.queryByRole("textbox")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
    page.dispose();
    pending.reject(new Error("Retired synthetic generation"));
    await pending.promise.catch(() => undefined);
  }
});
