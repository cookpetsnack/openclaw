import { assert, describe, expect, it } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";
import { validatedConfig, validationIssues } from "./validation.test-helpers.js";

function agentTools(tools: Record<string, unknown>) {
  return { agents: { entries: { main: { tools } } } };
}

const validConfig = (config: unknown) => validatedConfig(validateConfigObject(config));

function expectIssue(config: unknown, path: string) {
  const result = validateConfigObject(config);
  assert(!result.ok, "Expected invalid config");
  expect(result.issues.some((issue) => issue.path.startsWith(path))).toBe(true);
}

function validateBinding(agentId: string, entries: Record<string, unknown>) {
  return validateConfigObject({
    agents: { entries },
    bindings: [
      {
        type: "route",
        agentId,
        match: { channel: "discord", peer: { kind: "direct", id: "user-1" } },
      },
    ],
  });
}

describe("config schema regressions", () => {
  it("accepts and preserves mixed extra memory path entries", () => {
    const extraPaths = [
      "../team-notes",
      { path: "../shared", pattern: "runbooks/**/*.md", evergreen: true },
    ];
    const config = validConfig({
      memory: { search: { extraPaths } },
      agents: { entries: { main: {} } },
    });
    expect(config.memory?.search?.extraPaths).toEqual(extraPaths);
  });

  it.each([
    { pattern: "**/*.md" },
    { path: "../shared", pattern: 42 },
    { path: "../shared", evergreen: "yes" },
    { path: "../shared", name: "legacy-qmd-name" },
  ])("rejects invalid extra memory path object %j", (entry) => {
    expectIssue(
      { memory: { search: { extraPaths: [entry] } }, agents: { entries: { main: {} } } },
      "memory.search.extraPaths",
    );
  });

  it.each([["ops"], ["ops-*"], [], ["*"]].map((send) => ({ send })))(
    "accepts per-agent send destinations $send",
    ({ send }) => {
      const config = validConfig(agentTools({ agentToAgent: { send } }));
      expect(config.agents?.entries?.main?.tools?.agentToAgent?.send).toEqual(send);
    },
  );

  it.each(["ops", [1], { target: "ops" }].map((send) => ({ send })))(
    "rejects malformed send destinations $send",
    ({ send }) => {
      expect(validateConfigObject(agentTools({ agentToAgent: { send } })).ok).toBe(false);
    },
  );

  it("preserves the global exec approval notice delay (#115101)", () => {
    const config = validConfig({ tools: { exec: { approvalRunningNoticeMs: 0 } } });
    expect(config.tools?.exec?.approvalRunningNoticeMs).toBe(0);
  });

  it.each([
    ["main", "alpha", true],
    ["MAIN", "alpha", false],
    ["MAIN", "MAIN", true],
  ] as const)("validates binding %s with roster entry %s (#89419)", (agentId, configured, ok) => {
    const result = validateBinding(agentId, {
      [configured]: { model: "anthropic/claude-3-5-sonnet" },
    });
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes('Unknown agent id "MAIN"'))).toBe(
        true,
      );
    }
  });

  it("accepts persisted Foundry thinkingLevelMap (#91011)", () => {
    const model = {
      id: "gpt-5.1-chat",
      name: "gpt-5.1-chat",
      api: "openai-responses",
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    };
    validConfig({ models: { providers: { "microsoft-foundry": { models: [model] } } } });
  });

  it.each(["tools", "agents.entries.main.tools"])("rejects allow + alsoAllow at %s", (path) => {
    const tools = { allow: ["group:fs"], alsoAllow: ["lobster"] };
    const config = path === "tools" ? { tools } : agentTools(tools);
    const result = validateConfigObject(config);
    assert(!result.ok);
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it("allows profile + alsoAllow", () => {
    expect(validateConfigObject({ tools: { profile: "coding", alsoAllow: ["lobster"] } }).ok).toBe(
      true,
    );
  });
});

const provider = (fields: Record<string, unknown>) => ({
  baseUrl: "https://api.openai.com/v1",
  models: [{ id: "gpt-5", name: "gpt-5" }],
  ...fields,
});
const validateProvider = (fields: Record<string, unknown>) =>
  validateConfigObjectRaw({ models: { providers: { openai: provider(fields) } } });
const validateOpenAiApiKeyRef = (apiKey: unknown) => validateProvider({ apiKey });
const validateGithub = (github: Record<string, unknown>) =>
  validateConfigObjectRaw({ tools: { github } });
const secretRef = (source: string, id: string, providerId = "default") => ({
  source,
  provider: providerId,
  id,
});

function expectInvalidApiKey(apiKey: unknown, message: string) {
  const result = validateOpenAiApiKeyRef(apiKey);
  assert(!result.ok);
  expect(
    result.issues.some(
      (issue) =>
        issue.path.includes("models.providers.openai.apiKey") && issue.message.includes(message),
    ),
  ).toBe(true);
}

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const egressProxy = {
      enabled: true,
      allowedHosts: ["api.example.com"],
      bypassHosts: ["pinned.example.com"],
    };
    const result = validateConfigObjectRaw({
      secrets: {
        egressProxy: structuredClone(egressProxy),
        providers: {
          default: { source: "env" },
          filemain: {
            source: "file",
            path: "~/.openclaw/secrets.json",
            mode: "json",
            timeoutMs: 10_000,
          },
          vault: {
            source: "exec",
            command: "/usr/local/bin/openclaw-secret-resolver",
            args: ["resolve"],
          },
          store: { source: "store" },
        },
        defaults: { store: "store" },
      },
      models: {
        providers: {
          openai: provider({ apiKey: secretRef("env", "OPENAI_API_KEY") }),
          stored: provider({
            baseUrl: "https://stored.example.test/v1",
            apiKey: secretRef("store", "STORED_API_KEY", "store"),
            models: [{ id: "fixture", name: "fixture" }],
          }),
        },
      },
    });

    assert(result.ok);
    expect(result.config.secrets?.egressProxy).toEqual(egressProxy);
  });

  it.each(["allowedHosts", "bypassHosts"])("rejects wildcard secret egress %s", (field) => {
    const result = validateConfigObjectRaw({
      secrets: { egressProxy: { enabled: false, [field]: ["*.example.com"] } },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects store refs outside the env-name grammar", () => {
    expect(validateOpenAiApiKeyRef(secretRef("store", "lowercase")).ok).toBe(false);
  });

  it("accepts a preview SecretRef while keeping GitHub tool identity secret-free", () => {
    expect(
      validateConfigObjectRaw({
        gateway: {
          controlUi: { github: { token: secretRef("store", "CONTROL_UI_GITHUB") } },
        },
        tools: { github: { profileId: "ghp_77777777777777777777777777777777" } },
      }).ok,
    ).toBe(true);

    expect(
      validateGithub({
        profileId: "ghp_88888888888888888888888888888888",
        token: secretRef("store", "AGENT_GITHUB"),
      }).ok,
    ).toBe(false);
    expect(validateGithub({ profileId: "../../native" }).ok).toBe(false);
    expect(validateGithub({}).ok).toBe(false);
  });

  it("rejects model provider request proxy url secret refs", () => {
    const result = validateProvider({
      request: {
        proxy: { mode: "explicit-proxy", url: secretRef("env", "PROVIDER_PROXY_URL") },
      },
    });

    assert(!result.ok);
    expect(
      result.issues.some((issue) => issue.path.includes("models.providers.openai.request.proxy")),
    ).toBe(true);
  });

  it.each([
    ["env", "/providers/openai/apiKey", "Env secret reference id"],
    ["file", "providers/openai/apiKey", "absolute JSON pointer"],
  ])("rejects malformed %s references", (source, id, message) => {
    expectInvalidApiKey(secretRef(source, id), message);
  });
});

function issues(config: unknown) {
  return validationIssues(validateConfigObjectRaw(config));
}

function issueAt(config: unknown, path: string) {
  const issue = issues(config).find((entry) => entry.path === path);
  assert(issue, "expected validation issue at " + path);
  return issue;
}

describe("config validation allowed-values metadata", () => {
  it("does not infer allowed values from user text in collected config issues", () => {
    const text = 'expected one of "bogus"';
    const config = {
      agents: { entries: { main: {} } },
      bindings: [{ agentId: text, match: { channel: "discord" } }],
      broadcast: { "discord:qa": [text] },
      talk: { agentId: text, provider: text, providers: { qa: {} } },
    };
    const original = structuredClone(config);
    const result = issues(config);
    expect(result.map((issue) => issue.path).toSorted()).toEqual([
      "bindings.0.agentId",
      "broadcast.discord:qa.0",
      "talk.agentId",
      "talk.provider",
    ]);
    for (const issue of result) {
      expect(issue.message).toContain(text);
      expect(issue.allowedValues).toBeUndefined();
      expect(issue.allowedValuesHiddenCount).toBeUndefined();
    }
    expect(config).toEqual(original);
  });

  it("adds allowed values and non-enumerable path segments for invalid unions", () => {
    const issue = issueAt({ update: { channel: "nightly" } }, "update.channel");
    expect(issue.pathSegments).toEqual(["update", "channel"]);
    expect(JSON.stringify(issue)).not.toContain("pathSegments");
    expect(issue.message).toContain('(allowed: "stable", "extended-stable", "beta", "dev")');
    expect(issue.allowedValues).toEqual(["stable", "extended-stable", "beta", "dev"]);
    expect(issue.allowedValuesHiddenCount).toBe(0);
  });

  it("skips allowed-values hints for open-ended unions", () => {
    const issue = issueAt({ cron: { sessionRetention: true } }, "cron.sessionRetention");
    expect(issue.allowedValues).toBeUndefined();
    expect(issue.allowedValuesHiddenCount).toBeUndefined();
    expect(issue.message).not.toContain("(allowed:");
  });

  it("adds an exclusive lower-bound hint", () => {
    const issue = issueAt(
      { agents: { defaults: { maxConcurrent: 0 } } },
      "agents.defaults.maxConcurrent",
    );
    expect(issue.message).toContain("(must be greater than 0)");
  });

  it("selects the matching ACP union branch at bindings.0.acp", () => {
    const binding = {
      type: "acp",
      agentId: "test",
      match: { channel: "discord", peer: { kind: "direct", id: "123" } },
      acp: { agent: "claude" },
    };
    expect(issues({ bindings: [binding] })).toEqual([
      { path: "bindings.0.acp", message: 'Unrecognized key: "agent"' },
    ]);
  });

  it("names the replacement for a removed provider and model API", () => {
    const api = "openai-codex-responses";
    const providerConfig = { api, models: [{ id: "gpt-5.5", api }] };
    const result = issues({ models: { providers: { "openai-codex": providerConfig } } });
    const providerIssue = result.find(
      (issue) => issue.path === "models.providers.openai-codex.api",
    );
    expect(providerIssue?.message).toContain('"openai-codex-responses" is a removed api id');
    expect(providerIssue?.message).toContain('use "openai-chatgpt-responses"');
    expect(
      result.find((issue) => issue.path === "models.providers.openai-codex.models.0.api")?.message,
    ).toContain('use "openai-chatgpt-responses"');
  });
});
