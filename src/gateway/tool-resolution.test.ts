import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as gatewayTools from "../agents/tools/gateway.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunApprovalAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "../plugins/computer-use-registration.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginNodeHostCommand } from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { computerCapabilities } from "./desktop/computer.test-support.js";
import { useMcpCollectorRegistry } from "./mcp-http.collector-registry.test-support.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import * as pty from "./terminal/session-manager.test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

async function resolveTools(
  overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {},
) {
  return await resolveGatewayScopedTools({
    cfg: {},
    sessionKey: "agent:main:main",
    surface: "loopback",
    ...overrides,
  });
}
const toolNames = (result: { tools: { name: string }[] }) => result.tools.map(({ name }) => name);

beforeEach(() => setRuntimeConfigSnapshot({}));

it.each([
  ["webchat", false, true],
  ["whatsapp", false, false],
  ["webchat", true, false],
] as const)(
  "gates ask_user in %s (deny: %s, available: %s)",
  async (messageProvider, deny, available) => {
    const result = await resolveTools({
      cfg: {
        plugins: { enabled: false },
        tools: { allow: ["ask_user"], deny: deny ? ["ask_user"] : [] },
      },
      messageProvider,
      senderIsOwner: true,
    });
    expect(toolNames(result).includes("ask_user")).toBe(available);
  },
);

it("retains a computer execution across MCP catalog rebuilds and releases it with its run", async () => {
  const cfg = { plugins: { enabled: false }, tools: { allow: ["computer"] } };
  const admissions = ["computer-first", "computer-next"].map((runId) =>
    prepareSystemAgentRunAdmission(cfg, runId, "main", "mcp-computer-test"),
  );
  const contexts = await Promise.all(admissions.map((admission) => admission.admit("embedded")));
  const closed = contexts.map(() => createDeferredCore());
  const opens: string[] = [];
  const closes: string[] = [];
  const commands = new Map<string, OpenClawPluginNodeHostCommand>();
  const restrictedActions = [
    "browser_set_input_files",
    "browser_download",
    "get_recording_state",
    "start_recording",
    "stop_recording",
    "replay_trajectory",
  ] as const;
  const capabilities: ReturnType<ComputerUseProvider["capabilities"]> = {
    ...computerCapabilities(
      { id: "fixture", label: "Fixture", generation: "computer-generation" },
      ["screenshot", "list_windows", ...restrictedActions],
    ),
    features: { recording: true, agentCursor: false, multiDisplay: false },
  };
  registerComputerUseProvider(
    { registerNodeHostCommand: (command) => commands.set(command.command, command) },
    {
      id: "fixture",
      label: "Fixture",
      capabilities: () => capabilities,
      isAvailable: () => true,
      openExecution: async ({ executionId }) => {
        opens.push(executionId);
        return {
          snapshot: async () =>
            JSON.stringify({
              format: "png",
              displayFrameId: "fixture-frame",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            }),
          act: async () => JSON.stringify({ ok: true }),
          close: async (reason) => {
            closes.push(reason);
          },
        };
      },
    },
  );
  const transport = vi
    .spyOn(gatewayTools, "callGatewayTool")
    .mockImplementation(async <T>(method: string, _options: unknown, request?: unknown) => {
      let response: unknown;
      if (method === "node.list") {
        response = {
          nodes: [
            {
              nodeId: "computer-node",
              platform: "linux",
              connected: true,
              commands: [...commands.keys()],
              computerUse: capabilities,
            },
          ],
        };
      } else if (method === "computer.status") {
        response = { configured: false, available: false };
      } else if (method === "node.invoke") {
        assert(isRecord(request) && isRecord(request.params), "Malformed fixture node invocation");
        const command = commands.get(String(request.command));
        assert(command, "Unexpected node command");
        const params = request.params;
        if (params.action === "__close_execution") {
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        }
        response = { payload: JSON.parse(await command.handle(JSON.stringify(params))) };
        if (params.action === "__close_execution") {
          const index = contexts.findIndex(
            (context) => context.operationalRunInstance.instanceId === params.executionId,
          );
          closed[index]?.resolve();
        }
      } else {
        throw new Error(`Unexpected Gateway method: ${method}`);
      }
      // The fixture implements the generic Gateway wire response boundary.
      return response as T;
    });
  const cache = new McpLoopbackToolCache();
  const expectOrdinaryActions = (parameters: unknown) => {
    for (const action of restrictedActions) {
      expect(parameters).not.toMatchObject({
        properties: { action: { enum: expect.arrayContaining([action]) } },
      });
    }
  };
  const resolveComputer = async (index: number) => {
    const admittedRunContext = contexts[index]!;
    const resolved = await cache.resolve({
      cfg,
      admittedRunContext,
      grantToken: `computer-grant-${index}`,
      context: {
        sessionKey: "agent:main:computer",
        senderIsOwner: true,
        runId: admittedRunContext.operationalRunInstance.runId,
        toolsAllow: ["computer"],
        modelHasVision: true,
      },
    });
    const computer = resolved.tools.find((tool) => tool.name === "computer");
    assert(computer, "MCP computer tool was not available");
    return wrapToolWithGatewayCallerIdentity(computer, {
      agentId: "main",
      sessionKey: "agent:main:computer",
      operationalRunInstance: admittedRunContext.operationalRunInstance,
      approvalAuthority: getAdmittedRunDelegatedAuthority(admittedRunContext),
    });
  };
  try {
    const first = await resolveComputer(0);
    await first.execute("first-observation", { action: "screenshot", target: "node" });
    expectOrdinaryActions(first.parameters);
    const approval = claimAgentRunApprovalAuthority(
      getAdmittedRunDelegatedAuthority(contexts[0]!)!,
      [],
    );
    releaseAgentRunDelegatedAuthority(approval);
    await first.execute("after-approval", { action: "screenshot" });
    expect(closes).toEqual([]);
    cache.clear();
    const rebuilt = await resolveComputer(0);
    await rebuilt.execute("rebuilt-observation", { action: "screenshot", target: "node" });
    expectOrdinaryActions(rebuilt.parameters);
    expect(opens).toEqual([contexts[0]!.operationalRunInstance.instanceId]);
    admissions[0]!.close();
    await closed[0]!.promise;
    const next = await resolveComputer(1);
    await next.execute("next-observation", { action: "screenshot", target: "node" });
    expect(opens).toEqual(contexts.map((context) => context.operationalRunInstance.instanceId));
    admissions[1]!.close();
    await closed[1]!.promise;
    expect(closes).toEqual(["run-ended", "run-ended"]);
  } finally {
    admissions.forEach((admission) => admission.close());
    await commands.get("screen.snapshot")?.onDisconnect?.();
    cache.clear();
    transport.mockRestore();
  }
});

it("adds the message tool for Telegram room delivery", async () => {
  const result = await resolveTools({
    cfg: { tools: { profile: "minimal" } },
    sessionKey: "agent:main:telegram:group:-100123",
    messageProvider: "telegram",
    inboundEventKind: "room_event",
  });
  expect(toolNames(result)).toContain("message");
});

it("rejects collector mode after gateway policy removes its reader", async () => {
  const result = await resolveTools({
    cfg: {
      agents: { entries: { main: {} } },
      tools: { profile: "coding" },
      gateway: { tools: { deny: ["agents_wait"] } },
    },
  });
  const spawn = result.tools.find((tool) => tool.name === "sessions_spawn");
  expect(spawn).toBeDefined();
  expect(toolNames(result)).not.toContain("agents_wait");
  expect(spawn?.parameters).not.toHaveProperty("properties.collect");
  await expect(spawn!.execute("uncollectable", { task: "inspect", collect: true })).rejects.toThrow(
    "Collector results are unavailable",
  );
});

it("keeps default-agent credentials out of unbound gateway calls", async () => {
  const cfg = { agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } } };
  const unbound = await resolveTools({ cfg });
  const grantBound = await resolveTools({ cfg, agentDir: "/agents/cli" });
  expect(toolNames(unbound)).not.toContain("view_image");
  expect(toolNames(grantBound)).toContain("view_image");
});

it("keeps unknown and disabled model vision distinct in cached tools", async () => {
  const cache = new McpLoopbackToolCache();
  const cfg = { tools: { allow: ["computer"] } };
  for (const modelHasVision of [undefined, false]) {
    const result = await cache.resolve({
      cfg,
      context: {
        sessionKey: "agent:main:vision-context",
        senderIsOwner: true,
        modelHasVision,
      },
    });
    expect(toolNames(result).includes("computer")).toBe(modelHasVision !== false);
  }
});

it.each(["worker", "main"])(
  "binds runtime policy to %s without reassigning the session",
  async (agent) => {
    const resolving = resolveTools({
      cfg: {
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: {
            main: { tools: { profile: "full" } },
            worker: { tools: { profile: "coding" } },
          },
        },
      },
      agentId: "main",
      runtimePolicySessionKey: "agent:worker:main",
      runtimePolicyAgentId: agent,
      senderIsOwner: true,
    });
    if (agent === "main") {
      await expect(resolving).rejects.toThrowError(
        expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
      );
      return;
    }
    const result = await resolving;
    expect(result.agentId).toBe("main");
    expect(result.tools.find((tool) => tool.name === "gateway")?.parameters).toHaveProperty(
      "properties.action.enum",
      ["update.run"],
    );
  },
);

it.each([
  ["policy group", resolveMcpLoopbackPolicyTools, ["group:fs"], ["ls", "read"]],
  ["exact ls", resolveMcpLoopbackScopedTools, ["ls"], ["ls"]],
  ["exact group", resolveMcpLoopbackScopedTools, ["group:fs"], []],
] as const)(
  "materializes %s without widening its cap",
  async (_label, resolve, toolsAllow, expected) => {
    const scope = {
      cfg: {
        plugins: { enabled: false },
        tools: { profile: "minimal" as const, alsoAllow: ["ls", "read"] },
      },
      context: {
        sessionKey: "agent:main:cron:listing-surface",
        workspaceDir: path.join(os.tmpdir(), "openclaw-listing-surface"),
        senderIsOwner: true,
        toolsAllow: [...toolsAllow],
      },
    };
    const allowed = await resolve(scope);
    expect(toolNames(allowed)).toEqual(expected);
    const denied = await resolve({
      ...scope,
      cfg: { ...scope.cfg, tools: { ...scope.cfg.tools, deny: ["ls"] } },
    });
    expect(toolNames(denied)).toEqual(expected.filter((name) => name !== "ls"));
  },
);

it("keeps managed shell tools subject to explicit denies", async () => {
  const cfg = {
    plugins: { enabled: false },
    tools: { profile: "coding", deny: ["exec", "process"] },
  } satisfies OpenClawConfig;
  const context = { sessionKey: "agent:main:managed-shell", workspaceDir: os.tmpdir() };
  const projected = await resolveMcpLoopbackScopedTools({
    cfg,
    context,
    defaultMediatedToolNames: ["exec", "process"],
  });
  const toolsAllow = toolNames(projected);
  const granted = await resolveMcpLoopbackScopedTools({
    cfg,
    context: { ...context, toolsAllow },
  });
  for (const result of [projected, granted]) {
    expect(toolNames(result).filter((name) => ["exec", "process", "read"].includes(name))).toEqual(
      [],
    );
  }
});

it("applies sandbox tool denies to sandboxed loopback turns", async () => {
  const result = await resolveTools({
    cfg: {
      agents: { defaults: { sandbox: { mode: "all" } } },
      tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
    },
  });
  const names = toolNames(result);
  expect(names).not.toContain("sessions_list");
  expect(names).toContain("sessions_history");
});

describe("resolveGatewayScopedTools swarm collectors", () => {
  const runId = "cli-collector-run";
  const collectorSessionKey = "agent:main:subagent:cli-collector";
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };

  const buildConfig = (tools?: OpenClawConfig["tools"]): OpenClawConfig =>
    ({
      plugins: { enabled: false },
      agents: { entries: { main: {} } },
      tools: { swarm: true, ...tools },
    }) as OpenClawConfig;

  async function resolveCollectorTools(
    overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]> = {},
  ) {
    const cfg = overrides.cfg ?? buildConfig();
    setRuntimeConfigSnapshot(cfg);
    return (
      await resolveTools({
        cfg,
        runId,
        sessionKey: collectorSessionKey,
        ...overrides,
      })
    ).tools;
  }

  async function resolveNames(...args: Parameters<typeof resolveCollectorTools>) {
    return toolNames({ tools: await resolveCollectorTools(...args) });
  }

  async function updateCollector(
    update: (entry: SubagentRunRecord) => SubagentRunRecord,
    nextRunId = runId,
  ) {
    await mutateSubagentRuns(nextRunId === runId ? [runId] : [runId, nextRunId], (rows) => ({
      value: undefined,
      postimages: new Map<string, SubagentRunRecord | null>([
        [runId, null],
        [nextRunId, update(expectDefined(rows.get(runId), "collector run"))],
      ]),
    }));
  }

  useMcpCollectorRegistry({ runId, childSessionKey: collectorSessionKey, outputSchema: schema });

  it("keeps structured_output through a restrictive gateway tool policy", async () => {
    const names = await resolveNames({
      cfg: buildConfig({ allow: ["sessions_list"] }),
    });

    expect(names).toContain("sessions_list");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("sessions_search");
  });

  it.each([
    [
      "non-collector session",
      { sessionKey: "agent:main:subagent:cli-worker", runId: "cli-worker-run" },
      true,
    ],
    ["different run grant", { runId: "some-other-cli-run" }, true],
    ["captured result", {}, false],
  ] as const)("withholds collector transport for %s", async (_name, overrides, canYield) => {
    if (!canYield) {
      await updateCollector((entry) => ({
        ...entry,
        collectorCompletion: { status: "done", structured: { answer: "ok" } },
      }));
    }
    const names = await resolveNames(overrides);
    expect(names).not.toContain("structured_output");
    expect(names.includes("sessions_yield")).toBe(canYield);
  });

  it("passes collector identity into tool construction for a schema-less collector", async () => {
    const schemaLessRunId = "cli-schemaless-collector-run";
    const sessionKey = "agent:main:subagent:cli-schemaless-collector";
    await addSubagentRunForTests({
      runId: schemaLessRunId,
      childSessionKey: sessionKey,
      collect: true,
    });
    const tools = await resolveCollectorTools({ sessionKey, runId: schemaLessRunId });
    const names = tools.map((tool) => tool.name);
    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "structured_output"]) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain("sessions_list");
    const spawn = expectDefined(
      tools.find((tool) => tool.name === "sessions_spawn"),
      "collector sessions_spawn",
    );

    await expect(spawn.execute("nested", { task: "delegate" })).rejects.toThrow(
      "requires collect=true",
    );
  });
  it("admits the collector through the launch id a queued relaunch retains", async () => {
    // A relaunch retains the launch id as swarmRunId; both ids must admit the collector.
    const nextRunId = "cli-collector-relaunched";
    await updateCollector(
      (entry) => ({ ...entry, runId: nextRunId, swarmRunId: runId }),
      nextRunId,
    );

    for (const admittedRunId of [runId, "cli-collector-relaunched"]) {
      const names = await resolveNames({ runId: admittedRunId });
      expect(names).toContain("structured_output");
    }
  });

  it("keeps operator tool policy authoritative for a collector session on the http surface", async () => {
    const names = await resolveNames({
      surface: "http",
      runId: undefined,
      senderIsOwner: true,
      allowGatewaySubagentBinding: true,
      cfg: buildConfig({ allow: ["sessions_list"] }),
    });

    expect(names).toEqual(["sessions_list"]);
  });
  it("rejects the result when the grant is revoked between construction and execute", async () => {
    // Cached tools must recheck revocation after the awaited before-tool hook.
    let grantCurrent = true;
    const tools = await resolveCollectorTools({
      isGrantCurrent: () => grantCurrent,
    });
    const structuredOutput = expectDefined(
      tools.find((tool) => tool.name === "structured_output"),
      "collector output transport",
    );
    expect(structuredOutput.catalogMode).toBe("direct-only");

    grantCurrent = false;

    await expect(
      structuredOutput.execute("revoked-collector-result", {
        result: { answer: "ok" },
      }),
    ).rejects.toThrow("collector run grant is no longer active");
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toBeUndefined();
    expect(getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
  });
  it("hard-filters structured_output out of a grant that never merged it", async () => {
    const cfg = buildConfig();
    setRuntimeConfigSnapshot(cfg);
    const { tools } = await resolveMcpLoopbackScopedTools({
      cfg,
      context: {
        sessionKey: collectorSessionKey,
        senderIsOwner: false,
        toolsAllow: ["read"],
        runId,
      },
    });
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual(["read"]);
  });
});

it("preserves exact-session terminal controls while applying configured execution denial", async () => {
  const currentPty = pty.makeFakePty();
  const otherPty = pty.makeFakePty();
  const ptys = [currentPty, otherPty];
  const spawn = vi.fn(async () => ptys.shift() ?? pty.makeFakePty());
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const childSessionKey = "agent:main:loopback-task-2";
  const open = async (key: string, id?: string) =>
    pty.expectTerminalOpen(
      await manager.open(pty.baseOpenRequest({ owner: pty.agentTerminalOwner(key, id) })),
    ).sessionId;
  const currentId = await open(childSessionKey, "loopback-session-id");
  const otherId = await open("agent:main:loopback-task-1");
  currentPty.emitData("current session output\n");
  const context = { terminalSessions: manager } as unknown as GatewayRequestContext;
  const inScope = <T>(run: () => T) =>
    withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run);

  const cfg: OpenClawConfig = { tools: { allow: ["terminal"], exec: { mode: "deny" } } };
  setRuntimeConfigSnapshot(cfg);
  try {
    const result = await inScope(() =>
      resolveGatewayScopedTools({
        cfg,
        sessionKey: childSessionKey,
        sessionId: "loopback-session-id",
        execSession: { permissionMode: "read-only" },
        runId: "shared-run",
        senderIsOwner: true,
        surface: "loopback",
      }),
    );
    const terminal = result.tools.find((tool) => tool.name === "terminal");
    if (!terminal?.execute) {
      throw new Error("expected loopback terminal tool");
    }
    const execute = (action: string, params: Record<string, unknown> = {}) =>
      inScope(() => terminal.execute!("terminal-tool", { action, ...params }));
    const unavailable = (action: string, params: Record<string, unknown> = {}) =>
      expect(execute(action, { sessionId: otherId, ...params })).rejects.toThrow(
        "Terminal session unavailable",
      );

    await expect(execute("list")).resolves.toMatchObject({
      details: { sessions: [expect.objectContaining({ sessionId: currentId })] },
    });
    await expect(execute("read", { sessionId: currentId })).resolves.toMatchObject({
      details: { sessionId: currentId, text: "current session output\n" },
    });
    await unavailable("read");
    const size = { cols: 100, rows: 30 };
    await unavailable("resize", size);
    await expect(execute("resize", { sessionId: currentId, ...size })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect(currentPty.resizes).toEqual([[100, 30]]);
    spawn.mockClear();
    await expect(execute("open")).rejects.toThrow("terminal action unavailable");
    await expect(execute("input", { sessionId: currentId, data: "unsafe\r" })).rejects.toThrow(
      "Terminal input denied by execution policy",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect([currentPty.writes, otherPty.writes]).toEqual([[], []]);

    await unavailable("close");
    await expect(execute("close", { sessionId: currentId })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect([currentPty.killed, otherPty.killed]).toEqual([true, false]);
  } finally {
    manager.disposeAll();
    clearRuntimeConfigSnapshot();
  }
});
