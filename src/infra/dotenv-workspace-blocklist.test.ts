// Tests workspace dotenv blocklist completeness across shipped runtime controls.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { buildPluginMetadataProviderFacts } from "../plugins/plugin-metadata-provider-facts.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { loadDotEnv, loadDotEnvAsync, loadWorkspaceDotEnvFile } from "./dotenv.js";
import { clearEnv, envContents, useDotEnvFixture, writeEnvFile } from "./dotenv.test-support.js";

const fixture = useDotEnvFixture();

async function expectWorkspaceEnv(
  blocked: Record<string, string>,
  allowed: Record<string, string> = {},
) {
  const entries = { ...blocked, ...allowed };
  await writeEnvFile(path.join(fixture.cwdDir, ".env"), envContents(entries));
  clearEnv(Object.keys(entries));
  loadWorkspaceDotEnvFile(path.join(fixture.cwdDir, ".env"));
  for (const key of Object.keys(blocked)) {
    expect(process.env[key], `${key} should be blocked by workspace .env`).toBeUndefined();
  }
  for (const [key, value] of Object.entries(allowed)) {
    expect(process.env[key], key).toBe(value);
  }
}

function createManifestBackedProviderSnapshot(
  plugin: PluginManifestRecord,
): PluginMetadataSnapshot {
  const empty = createEmptyPluginMetadataSnapshot();
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index = { ...empty.index, policyHash, generatedAtMs: 0 };
  return {
    ...empty,
    policyHash,
    index,
    registryIndex: index,
    manifestRegistry: { plugins: [plugin], diagnostics: [] },
    plugins: [plugin],
    byPluginId: new Map([[plugin.id, plugin]]),
    declaredProviderOwners: buildDeclaredProviderOwnerIndex([plugin]),
    owners: { ...empty.owners, ...buildPluginMetadataProviderFacts([plugin]) },
    metrics: { ...empty.metrics, manifestPluginCount: 1 },
  };
}

describe("workspace .env blocklist completeness", () => {
  it.each(["sync", "async"])(
    "keeps OCM launch context trusted with the %s loader",
    async (mode) => {
      const { base, cwdDir, stateDir } = fixture;
      try {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OCM_SELF=workspace-executable",
            "OCM_HOME=workspace-home",
            "OCM_ACTIVE_ENV=workspace-environment",
            "OCM_ACTIVE_ENV_ROOT=workspace-root",
            "OCM_SUPERVISOR_MODE=workspace-supervisor",
            "PROJECT_NAME=allowed",
          ].join("\n"),
        );
        await writeEnvFile(
          path.join(stateDir, ".env"),
          "OCM_SELF=global-executable\nOCM_HOME=global-home\n",
        );
        const env: NodeJS.ProcessEnv = {
          HOME: base,
          OPENCLAW_STATE_DIR: stateDir,
          OCM_ACTIVE_ENV: "inherited-environment",
        };
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        if (mode === "async") {
          await loadDotEnvAsync({ env, cwd: cwdDir });
        } else {
          loadDotEnv({ env });
        }

        expect(env).toEqual({
          HOME: base,
          OPENCLAW_STATE_DIR: stateDir,
          OCM_SELF: "global-executable",
          OCM_HOME: "global-home",
          OCM_ACTIVE_ENV: "inherited-environment",
          PROJECT_NAME: "allowed",
        });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it("keeps trusted global dotenv for global plugin provider auth vars", async () => {
    const { cwdDir, stateDir } = fixture;
    const plugin: PluginManifestRecord = {
      id: "runtime-cloud",
      channels: [],
      providers: ["runtime-cloud"],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "global",
      rootDir: "/plugins/runtime-cloud",
      source: "/plugins/runtime-cloud/index.js",
      manifestPath: "/plugins/runtime-cloud/openclaw.plugin.json",
      setup: { providers: [{ id: "runtime-cloud", envVars: ["RUNTIME_CLOUD_API_KEY"] }] },
    };
    await writeEnvFile(path.join(cwdDir, ".env"), "RUNTIME_CLOUD_API_KEY=workspace-plugin-key\n");
    await writeEnvFile(path.join(stateDir, ".env"), "RUNTIME_CLOUD_API_KEY=global-plugin-key\n");

    delete process.env.RUNTIME_CLOUD_API_KEY;
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    setCurrentPluginMetadataSnapshot(createManifestBackedProviderSnapshot(plugin), {
      config: {},
      env: process.env,
    });

    try {
      loadDotEnv();

      expect(process.env.RUNTIME_CLOUD_API_KEY).toBe("global-plugin-key");
    } finally {
      clearPluginMetadataLifecycleCaches();
    }
  });

  it("keeps registered provider auth vars from trusted global dotenv", async () => {
    const { cwdDir, stateDir } = fixture;
    const providerAuthKeys = listKnownProviderAuthEnvVarNamesCore().toSorted();
    await writeEnvFile(
      path.join(cwdDir, ".env"),
      `${providerAuthKeys.map((key) => `${key}=workspace-${key}`).join("\n")}\n`,
    );
    await writeEnvFile(
      path.join(stateDir, ".env"),
      `${providerAuthKeys.map((key) => `${key}=global-${key}`).join("\n")}\n`,
    );

    clearEnv(providerAuthKeys);
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

    loadDotEnv();

    for (const key of providerAuthKeys) {
      expect(process.env[key], `${key} should come from trusted global .env`).toBe(`global-${key}`);
    }
  });

  it("blocks runtime-control variables from workspace .env", async () => {
    const keys = `
      OPENCLAW_GIT_DIR OPENCLAW_WORKSPACE_DIR OPENCLAW_MDNS_HOSTNAME
      OPENCLAW_SESSION_CACHE_TTL_MS OPENCLAW_UPDATE_PACKAGE_SPEC OPENCLAW_GATEWAY_PORT
      OPENCLAW_GATEWAY_URL OPENCLAW_CLAWHUB_URL CLAWHUB_URL
      CLAWHUB_TOKEN CLAWHUB_AUTH_TOKEN CLAWHUB_CONFIG_PATH
      OPENCLAW_DISABLE_BUNDLED_PLUGINS OPENCLAW_ALLOW_INSECURE_PRIVATE_WS OPENCLAW_BROWSER_EXECUTABLE_PATH
      OPENCLAW_WHATSAPP_WEB_SOCKET_URL EXAMPLE_API_HOST HOMEBREW_API_DOMAIN
      HOMEBREW_ARTIFACT_DOMAIN HOMEBREW_BOTTLE_DOMAIN HOMEBREW_BREW_FILE
      HOMEBREW_BREW_GIT_REMOTE HOMEBREW_CORE_GIT_REMOTE HOMEBREW_CURL_PATH
      HOMEBREW_CURLRC HOMEBREW_GIT_PATH HOMEBREW_PREFIX
      HOMEBREW_SSH_CONFIG_PATH HOMEBREW_XDG_CONFIG_HOME IRC_HOST
      APPDATA LOCALAPPDATA DISCORD_API_URL
      MATTERMOST_URL MATRIX_HOMESERVER MINIMAX_API_HOST
      BUZZ_RELAY_URL SMS_ALLOWED_USERS SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION
      SMS_PUBLIC_WEBHOOK_URL AWS_ACCESS_KEY_ID AWS_ACCOUNT_ID
      AWS_ACCOUNT_ID_ENDPOINT_MODE AWS_BEARER_TOKEN_BEDROCK AWS_BEDROCK_SKIP_AUTH
      AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_FULL_URI
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONFIG_FILE AWS_CREDENTIAL_EXPIRATION
      AWS_CREDENTIAL_SCOPE AWS_EC2_METADATA_DISABLED AWS_EC2_METADATA_SERVICE_ENDPOINT
      AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE AWS_EC2_METADATA_V1_DISABLED AWS_ENDPOINT_URL
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME AWS_PROFILE AWS_ROLE_ARN
      AWS_ROLE_SESSION_NAME AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
      AWS_SHARED_CREDENTIALS_FILE AWS_WEB_IDENTITY_TOKEN_FILE SYNOLOGY_ALLOWED_USER_IDS
      FUTURE_CHANNEL_DISABLE_SIGNATURE_VALIDATION FUTURE_PLUGIN_DANGEROUSLY_ALLOW_UNTRUSTED FUTURE_PROVIDER_SKIP_AUTH
      BROWSER_EXECUTABLE_PATH CLOUDSDK_CONFIG CLOUDSDK_PYTHON
      CLOUDSDK_PYTHON_ARGS CLOUDSDK_PYTHON_SITEPACKAGES PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      OPENCLAW_SKIP_CHANNELS OPENCLAW_SKIP_PROVIDERS OPENCLAW_SKIP_CRON
      OPENCLAW_RAW_STREAM OPENCLAW_RAW_STREAM_PATH OPENCLAW_CACHE_TRACE
      OPENCLAW_CACHE_TRACE_FILE OPENCLAW_CACHE_TRACE_MESSAGES OPENCLAW_CACHE_TRACE_PROMPT
      OPENCLAW_CACHE_TRACE_SYSTEM OPENCLAW_SHOW_SECRETS OPENCLAW_PLUGIN_CATALOG_PATHS
      OPENCLAW_MPM_CATALOG_PATHS OPENCLAW_NODE_EXEC_HOST OPENCLAW_NODE_EXEC_FALLBACK
      OPENCLAW_ALLOW_PROJECT_LOCAL_BIN PATH SystemRoot
      WINDIR ProgramFiles ProgramFiles(x86)
      ProgramW6432 STATE_DIRECTORY SYNOLOGY_CHAT_INCOMING_URL
      SYNOLOGY_NAS_HOST
    `
      .trim()
      .split(/\s+/);
    await expectWorkspaceEnv(Object.fromEntries(keys.map((key) => [key, `INJECTED_${key}`])));
  });

  it("still allows user-defined non-control vars through workspace .env", async () => {
    await expectWorkspaceEnv(
      {},
      {
        MY_APP_KEY: "user-value",
        APP_GITHUB_REPO: "openclaw/openclaw",
        APP_URL: "https://project.example.com",
        APP_ALLOWED_USERS: "alice,bob",
        DATABASE_URL_CUSTOM: "pg://localhost",
        MY_SKIP_AUTHORS: "notes",
        VITE_DISABLE_AUTHENTICATION: "false",
      },
    );
  });

  it("blocks Matrix per-account scoped homeserver vars from workspace .env", async () => {
    await expectWorkspaceEnv({
      MATRIX_DEFAULT_HOMESERVER: "https://evil-default.example.com",
      MATRIX_OPS_HOMESERVER: "https://evil-ops.example.com",
    });
  });

  it("blocks generic endpoint-routing suffixes from workspace .env", async () => {
    await expectWorkspaceEnv(
      {
        FUTURE_PROVIDER_API_HOST: "https://evil.example.com",
        FUTURE_PROVIDER_BASE_URL: "https://evil.example.com/v1",
        FUTURE_PROVIDER_ENDPOINT: "https://evil.example.com/api",
      },
      { APP_URL: "https://project.example.com", SAFE_PROVIDER_DSN: "postgres://localhost" },
    );
  });
});
