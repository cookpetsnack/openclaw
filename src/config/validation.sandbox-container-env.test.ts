import { assert, describe, expect, it } from "vitest";
import {
  DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS,
  resolveSandboxConfigForAgent,
} from "../agents/sandbox/config.js";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";
import { validatedConfig } from "./validation.test-helpers.js";

const dockerEnv = { env: { SYNTHETIC_VALUE: "synthetic-first\nsynthetic-second" } };
const validateAgents = (agents: OpenClawConfig["agents"]) => validateConfigObject({ agents });

describe("sandbox container environment validation", () => {
  it.each([
    { backend: "docker", key: "SYNTHETIC-BAD-NAME", value: "synthetic-private-invalid-name-value" },
    {
      backend: "podman",
      key: "SYNTHETIC_NUL",
      value: "synthetic-private-before\0synthetic-private-after",
    },
  ])("rejects $key without exposing values", ({ backend, key, value }) => {
    const result = validateConfigObject({
      agents: { defaults: { sandbox: { backend, docker: { env: { [key]: value } } } } },
    });
    assert(!result.ok);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0]!;
    expect(issue.path).toBe("agents.defaults.sandbox.docker.env." + key);
    for (const hint of [
      key,
      backend === "podman" ? "Podman" : "Docker",
      "portable",
      "single-line",
      "NUL",
      "line-delimited",
      "openclaw doctor",
      "manual remediation",
      "SSH/OpenShell",
      key === "SYNTHETIC-BAD-NAME" ? "Rename key" : "mounted file or custom image",
    ]) {
      expect(issue.message).toContain(hint);
    }
    expect(issue.message).not.toContain("doctor --fix");
    for (const fragment of value.split(/[\r\n\0]/u).filter(Boolean)) {
      expect(issue.message).not.toContain(fragment);
    }
  });

  it("accepts unused Docker defaults when every explicit agent uses a remote backend", () => {
    expect(
      validateAgents({
        ownership: "explicit",
        defaults: { sandbox: { backend: "docker", docker: dockerEnv } },
        entries: {
          synthetic_ssh: { sandbox: { backend: "ssh" } },
          synthetic_openshell: { sandbox: { backend: "openshell" } },
        },
      }).ok,
    ).toBe(true);
  });

  it("reports inherited invalid defaults once across container backends", () => {
    const result = validateAgents({
      ownership: "explicit",
      defaults: { sandbox: { backend: "ssh", docker: dockerEnv } },
      entries: {
        synthetic_docker: { sandbox: { backend: "docker" } },
        synthetic_podman: { sandbox: { backend: "podman" } },
      },
    });
    assert(!result.ok);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe("agents.defaults.sandbox.docker.env.SYNTHETIC_VALUE");
  });

  it("attributes agent-owned podman values to their config path", () => {
    const config = {
      agents: {
        defaults: { sandbox: { backend: "ssh" } },
        entries: { synthetic_agent: { sandbox: { backend: "podman", docker: dockerEnv } } },
      },
    };
    const result = validateConfigObject(config, { sourceRaw: config });
    assert(!result.ok);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "agents.entries.synthetic_agent.sandbox.docker.env.SYNTHETIC_VALUE",
      }),
    ]);
  });

  it("ignores agent environment overrides in shared scope", () => {
    expect(
      validateAgents({
        defaults: {
          sandbox: {
            scope: "shared",
            docker: { env: { SYNTHETIC_SHARED: "synthetic-single-line" } },
          },
        },
        entries: { synthetic_agent: { sandbox: { docker: dockerEnv } } },
      }).ok,
    ).toBe(true);
  });
});

function validateSandbox(sandbox: unknown, agent?: unknown) {
  return validateConfigObject({
    agents: { defaults: { sandbox }, ...(agent ? { entries: { main: { sandbox: agent } } } : {}) },
  });
}

function parsedSandbox(sandbox: unknown, agent?: unknown) {
  return validatedConfig(validateSandbox(sandbox, agent)).agents;
}

function resolveSandbox(defaults: AgentSandboxConfig, agent: AgentSandboxConfig = {}) {
  return resolveSandboxConfigForAgent(
    { agents: { defaults: { sandbox: defaults }, entries: { test: { sandbox: agent } } } },
    "test",
  );
}

it("joins setupCommand arrays with newlines", () => {
  const agents = parsedSandbox({ docker: { setupCommand: ["first", "second"] } });
  expect(agents?.defaults?.sandbox?.docker?.setupCommand).toBe("first\nsecond");
});

it("preserves global and per-agent Docker binds", () => {
  const binds = ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"];
  const agentBinds = ["/home/user/projects:/projects:ro"];
  const agents = parsedSandbox({ docker: { binds } }, { docker: { binds: agentBinds } });
  expect(agents?.defaults?.sandbox?.docker?.binds).toEqual(binds);
  expect(agents?.entries?.main?.sandbox?.docker?.binds).toEqual(agentBinds);
});

it.each([
  ["docker", " /home/user/source:/data", false],
  ["docker", "/home/user/source :/data ", true],
  ["browser", " /home/user/source:/data", false],
  ["browser", "/home/user/source :/data ", true],
] as const)("validates %s bind %s without trimming path bytes", (backend, bind, accepted) => {
  const result = validateSandbox({ [backend]: { binds: [bind] } });
  expect(result.ok, bind).toBe(accepted);
  if (result.ok) {
    expect(result.config.agents?.defaults?.sandbox?.[backend]?.binds).toEqual([bind]);
  }
});

it.each([
  ["docker", "network", "host"],
  ["docker", "network", "container:peer"],
  ["docker", "seccompProfile", "unconfined"],
  ["docker", "apparmorProfile", "unconfined"],
  ["browser", "network", "host"],
  ["browser", "network", "container:peer"],
] as const)("rejects %s %s=%s", (kind, field, value) => {
  expect(validateSandbox({ [kind]: { [field]: value } }).ok).toBe(false);
});

it.each(["docker", "browser"] as const)("allows %s namespace join with override", (kind) => {
  const docker = { dangerouslyAllowContainerNamespaceJoin: true };
  const network = { network: "container:peer" };
  const sandbox =
    kind === "docker" ? { docker: { ...docker, ...network } } : { docker, browser: network };
  expect(validateSandbox(sandbox).ok).toBe(true);
});

it("uses agent override precedence for dangerous sandbox docker booleans", () => {
  for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
    const defaults = { scope: "agent", docker: { [key]: true } } satisfies AgentSandboxConfig;
    const override = { docker: { [key]: false } };
    expect(resolveSandbox(defaults).docker[key]).toBe(true);
    expect(resolveSandbox(defaults, override).docker[key]).toBe(false);
    expect(resolveSandbox({ ...defaults, scope: "shared" }, override).docker[key]).toBe(true);
  }
});
it.each([{ binds: ["/g:/g:ro"] }, { binds: undefined }])(
  "ignores agent browser binds under shared scope: %j",
  (browser) => {
    const resolved = resolveSandbox(
      { scope: "shared", browser },
      { browser: { binds: ["/a:/a:rw"] } },
    ).browser;
    expect(resolved).toMatchObject({ binds: browser.binds, network: "openclaw-sandbox-browser" });
  },
);
